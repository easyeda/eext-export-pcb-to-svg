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
	sys_Dialog: {
		showInformationMessage: (title: string, msg: string) => void;
		showSelectDialog: <T extends boolean>(
			options: Array<{ value: string; displayContent: string }>,
			beforeContent: string,
			afterContent: string,
			title: string,
			defaultOption: T extends true ? string[] : string,
			multiple: T,
			callbackFn: (value: T extends true ? string[] : string) => void,
		) => void;
		showConfirmationMessage: (
			content: string,
			title?: string,
			mainButtonTitle?: string,
			buttonTitle?: string,
			callbackFn?: (mainButtonClicked: boolean) => void,
		) => void;
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
	openPcbFirst: 'Please open a PCB document first.',
	noLayers: 'No Gerber layers found in the export bundle.',
	noBoards: 'No boards found in the current project.',
	collecting: 'Exporting Gerber, please wait...',
	menuHint: 'Please open the PCB document and use the Export PCB to SVG menu.',
	exportedForBoard: (count: number, board: string) => `Exported ${count} SVG file(s) for ${board}.`,
	exportedBoards: (count: number) => `Exported ${count} board(s).`,
	exportFailed: (reason: string) => `Export failed: ${reason}`,
	aboutTitle: (version: string) => `Export PCB to SVG v${version}`,
	about: 'About',
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

function showSelectDialogAsync(
	options: Array<{ value: string; displayContent: string }>,
	title: string,
	defaultOption: string[],
): Promise<string[]> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showSelectDialog(
			options,
			'',
			'',
			title,
			defaultOption,
			true,
			(value) => { resolve((value as string[]) || []); },
		);
	});
}

function showConfirmationMessageAsync(
	content: string,
	title: string,
	mainButtonTitle = '确定',
	buttonTitle = '取消',
): Promise<boolean> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showConfirmationMessage(content, title, mainButtonTitle, buttonTitle, (clicked) => {
			resolve(clicked);
		});
	});
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

		const layerOptions = allLayers.map((l, i) => ({
			value: String(i),
			displayContent: `${l.layerName} (${l.originalFilename})`,
		}));
		const selectedIndexes = await showSelectDialogAsync(
			layerOptions,
			'选择要导出的 Gerber 层',
			allLayers.map((_, i) => String(i)),
		);
		if (!selectedIndexes || selectedIndexes.length === 0)
			return;

		const selectedLayers = selectedIndexes.map(idx => allLayers[Number(idx)]).filter(Boolean);
		const mirrorOptions = selectedLayers.map(l => ({
			value: l.originalFilename,
			displayContent: `${l.layerName} (${l.originalFilename})`,
		}));
		const mirroredIds = await showSelectDialogAsync(
			mirrorOptions,
			'选择需要水平镜像的层（可选）',
			[],
		);

		const merge = await showConfirmationMessageAsync(
			'选择导出模式：合并为一个 SVG，或独立导出每个层？',
			'导出模式',
			'合并导出',
			'独立导出',
		);

		const pourById = await collectPourNets();
		console.log(`[export-pcb-svg] custom step: selected=${selectedLayers.length}, mirror=${(mirroredIds || []).length}, merge=${merge}`);
		const renderOptions: RenderOptions = {
			merge,
			mirrorLayerIds: new Set(mirroredIds || []),
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
