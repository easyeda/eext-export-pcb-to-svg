/**
 * 嘉立创EDA 扩展入口：导出 PCB 为按层拆分的 SVG 文件，并打包为 ZIP。
 *
 * 流程：`getGerberFile` → JSZip 解压 → tracespace 解析/铺铜 → 自定义 SVG 拼装 → ZIP 打包。
 */

import type { RenderOptions } from './gerber-render.ts';
import extensionConfig from '../extension.json' with { type: 'json' };
import { renderGerberLayersToSvgs } from './gerber-render.ts';
import { collectGerberSources } from './gerber-source.ts';
import { collectPourNets } from './pour-net.ts';
import { buildZipBlobFromText } from './zip-builder.ts';

declare const eda: {
	sys_Message: { showToastMessage: (msg: string) => void };
	sys_Dialog: { showInformationMessage: (title: string, msg: string) => void };
	sys_IFrame: {
		openIFrame: (
			htmlFileName: string,
			width?: number,
			height?: number,
			id?: string,
			props?: {
				title?: string;
				buttonCallbackFn?: (button: 'close' | 'minimize' | 'maximize') => void;
			},
		) => Promise<boolean>;
		closeIFrame: (id?: string) => Promise<boolean>;
	};
	sys_I18n: { text: (key: string, fallback?: string, ...args: unknown[]) => string };
	sys_FileSystem: { saveFile: (blob: Blob, name: string) => Promise<boolean> };
	dmt_SelectControl: { getCurrentDocumentInfo: () => Promise<{ documentType?: number } | null> };
	dmt_Project: { getCurrentProjectInfo: () => Promise<{ friendlyName?: string; name?: string } | null> };
	dmt_Board: {
		getCurrentBoardInfo: () => Promise<{ name?: string; pcb?: { name?: string } } | null>;
		getAllBoardsInfo: () => Promise<Array<{ name?: string; pcb?: { name?: string } }>>;
	};
	pcb_Layer: { getAllLayers: () => Promise<Array<{ id: number; name: string; color: string; type: string }>> };
	pcb_ManufactureData: {
		getGerberFile: (
			fileName?: string,
			colorSilkscreen?: boolean,
			unit?: number,
			digitalFormat?: { integerNumber: number; decimalNumber: number },
		) => Promise<File | null | undefined>;
	};
};

function sanitizeFilename(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'PCB';
}

function t(key: string, fallback: string, ...args: unknown[]): string {
	try {
		const v = eda.sys_I18n.text(key, fallback, ...args);
		if (v && v !== key)
			return v;
	}
	catch {}
	return fallback;
}

const MESSAGES = {
	openPcbFirst: '请先打开 PCB 文档。',
	noLayers: '导出包中没有找到 Gerber 层。',
	noBoards: '当前工程中没有找到板子。',
	collecting: '正在导出 Gerber，请稍候...',
	menuHint: '请打开 PCB 文档并使用“导出 PCB 为 SVG”菜单。',
	exportedForBoard: (count: number, board: string) => `已为 ${board} 导出 ${count} 个 SVG 文件。`,
	exportedBoards: (count: number) => `已导出 ${count} 个板子。`,
	exportFailed: (reason: string) => `导出失败：${reason}`,
	aboutTitle: (version: string) => `导出 PCB 为 SVG v${version}`,
	about: '关于',
} as const;

async function checkPcbActive(): Promise<boolean> {
	try {
		const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		return !!doc && doc.documentType === 3; // EDMT_EditorDocumentType.PCB
	}
	catch {
		return false;
	}
}

interface BoardNameInfo {
	boardName: string;
	pcbName: string | null;
}

async function getBoardNameInfo(): Promise<BoardNameInfo> {
	try {
		const info = await eda.dmt_Board.getCurrentBoardInfo();
		const boardName = info?.name || null;
		const pcbName = info?.pcb?.name || null;
		if (boardName || pcbName)
			return { boardName: boardName || 'PCB', pcbName };
		const project = await eda.dmt_Project.getCurrentProjectInfo();
		if (project?.friendlyName)
			return { boardName: project.friendlyName, pcbName: null };
		if (project?.name)
			return { boardName: project.name, pcbName: null };
		return { boardName: 'PCB', pcbName: null };
	}
	catch {
		return { boardName: 'PCB', pcbName: null };
	}
}

async function exportOneBoard(boardName: string, pcbName: string | null): Promise<{ zipName: string; blob: Blob; fileCount: number }> {
	console.log('[export-pcb-svg] step: getGerberFile');
	const layers = await collectGerberSources();
	console.log(`[export-pcb-svg] step: layers=${layers.length}`);

	if (layers.length === 0)
		throw new Error('No Gerber layers in bundle');

	const pourById = await collectPourNets();
	console.log(`[export-pcb-svg] step: pourNets=${pourById.size}`);

	console.log('[export-pcb-svg] step: render SVG');
	const rendered = await renderGerberLayersToSvgs(layers, pourById);
	const fileMap: Record<string, string> = {};
	for (const f of rendered) fileMap[f.filename] = f.content;

	const blob = await buildZipBlobFromText(fileMap);
	const parts = ['SVG', sanitizeFilename(boardName)];
	if (pcbName)
		parts.push(sanitizeFilename(pcbName));
	const zipName = `${parts.join('_')}.zip`;
	return { zipName, blob, fileCount: rendered.length };
}

interface CustomExportResult {
	selected: string[];
	mirrored: string[];
	merge: boolean;
}

async function showCustomExportDialog(layers: Array<{ originalFilename: string; layerName: string }>): Promise<CustomExportResult | null> {
	const iframeId = 'exportPcbSvgCustomDialog';
	await eda.sys_IFrame.closeIFrame(iframeId).catch(() => {});

	const result = await new Promise<CustomExportResult | null>((resolve) => {
		let ready = false;
		let resolved = false;

		function cleanup() {
			globalThis.removeEventListener?.('message', onMessage);
			eda.sys_IFrame.closeIFrame(iframeId).catch(() => {});
		}

		function onMessage(e: MessageEvent) {
			const data = e.data as { type?: string; selected?: string[]; mirrored?: string[]; merge?: boolean } | undefined;
			if (!data || typeof data !== 'object')
				return;
			if (data.type === 'ready') {
				if (ready)
					return;
				ready = true;
				// 查找所有 iframe，把 init 数据发给目标窗口
				const frames = globalThis.document?.querySelectorAll('iframe') || [];
				for (const frame of frames) {
					try {
						frame.contentWindow?.postMessage({ type: 'init', layers }, '*');
					}
					catch {}
				}
			}
			else if (data.type === 'result') {
				if (resolved)
					return;
				resolved = true;
				resolve({
					selected: Array.isArray(data.selected) ? data.selected : [],
					mirrored: Array.isArray(data.mirrored) ? data.mirrored : [],
					merge: !!data.merge,
				});
				cleanup();
			}
			else if (data.type === 'cancel') {
				if (resolved)
					return;
				resolved = true;
				resolve(null);
				cleanup();
			}
		}

		globalThis.addEventListener?.('message', onMessage);
		eda.sys_IFrame.openIFrame('/iframe/custom-export.html', 520, 520, iframeId, {
			title: '自定义导出',
			buttonCallbackFn: (button) => {
				if (button === 'close' && !resolved) {
					resolved = true;
					resolve(null);
					cleanup();
				}
			},
		});
	});

	return result;
}

export function activate(_status?: 'onStartupFinished', _arg?: string): void {
	// no-op
}

export function menuPlaceholder(): void {
	eda.sys_Message.showToastMessage(t(MESSAGES.menuHint, MESSAGES.menuHint));
}

export async function exportCurrentBoardToSvg(): Promise<void> {
	try {
		if (!(await checkPcbActive())) {
			eda.sys_Dialog.showInformationMessage('', t(MESSAGES.openPcbFirst, MESSAGES.openPcbFirst));
			return;
		}
		const { boardName, pcbName } = await getBoardNameInfo();
		eda.sys_Message.showToastMessage(t(MESSAGES.collecting, MESSAGES.collecting));

		const { zipName, blob, fileCount } = await exportOneBoard(boardName, pcbName);
		console.log(`[export-pcb-svg] step: fileCount=${fileCount}`);

		if (fileCount === 0) {
			eda.sys_Dialog.showInformationMessage('', t(MESSAGES.noLayers, MESSAGES.noLayers));
			return;
		}

		await eda.sys_FileSystem.saveFile(blob, zipName);
		eda.sys_Message.showToastMessage(MESSAGES.exportedForBoard(fileCount, boardName));
	}
	catch (e) {
		console.error('[export-pcb-svg] exportCurrentBoardToSvg failed:', e);
		eda.sys_Message.showToastMessage(MESSAGES.exportFailed(String((e as Error)?.message ?? e)));
	}
}

export async function exportCurrentBoardToSvgCustom(): Promise<void> {
	try {
		if (!(await checkPcbActive())) {
			eda.sys_Dialog.showInformationMessage('', t(MESSAGES.openPcbFirst, MESSAGES.openPcbFirst));
			return;
		}
		const { boardName, pcbName } = await getBoardNameInfo();
		eda.sys_Message.showToastMessage(t(MESSAGES.collecting, MESSAGES.collecting));

		const allLayers = await collectGerberSources();
		console.log(`[export-pcb-svg] custom step: layers=${allLayers.length}`);
		if (allLayers.length === 0) {
			eda.sys_Dialog.showInformationMessage('', t(MESSAGES.noLayers, MESSAGES.noLayers));
			return;
		}

		const dialogResult = await showCustomExportDialog(allLayers.map(l => ({
			originalFilename: l.originalFilename,
			layerName: l.layerName,
		})));
		if (!dialogResult)
			return;

		const selectedLayers = allLayers.filter(l => dialogResult.selected.includes(l.originalFilename));
		if (selectedLayers.length === 0)
			return;

		const pourById = await collectPourNets();
		console.log(`[export-pcb-svg] custom step: selected=${selectedLayers.length}, mirror=${dialogResult.mirrored.length}, merge=${dialogResult.merge}`);
		const renderOptions: RenderOptions = {
			merge: dialogResult.merge,
			mirrorLayerIds: new Set(dialogResult.mirrored),
		};
		const rendered = await renderGerberLayersToSvgs(selectedLayers, pourById, renderOptions);

		const fileMap: Record<string, string> = {};
		for (const f of rendered)
			fileMap[f.filename] = f.content;
		const blob = await buildZipBlobFromText(fileMap);

		const parts = ['SVG', sanitizeFilename(boardName)];
		if (pcbName)
			parts.push(sanitizeFilename(pcbName));
		const zipName = `${parts.join('_')}.zip`;

		await eda.sys_FileSystem.saveFile(blob, zipName);
		eda.sys_Message.showToastMessage(MESSAGES.exportedForBoard(rendered.length, boardName));
	}
	catch (e) {
		console.error('[export-pcb-svg] exportCurrentBoardToSvgCustom failed:', e);
		eda.sys_Message.showToastMessage(MESSAGES.exportFailed(String((e as Error)?.message ?? e)));
	}
}

export async function exportAllBoardsToSvg(): Promise<void> {
	try {
		const allBoards = await eda.dmt_Board.getAllBoardsInfo();
		if (!Array.isArray(allBoards) || allBoards.length === 0) {
			eda.sys_Dialog.showInformationMessage('', t(MESSAGES.noBoards, MESSAGES.noBoards));
			return;
		}
		// 当前 EDA 没有 per-board Gerber 接口，先只导出当前 PCB
		await exportCurrentBoardToSvg();
	}
	catch (e) {
		console.error('[export-pcb-svg] exportAllBoardsToSvg failed:', e);
		eda.sys_Message.showToastMessage(MESSAGES.exportFailed(String((e as Error)?.message ?? e)));
	}
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		MESSAGES.aboutTitle(extensionConfig.version),
		MESSAGES.about,
	);
}
