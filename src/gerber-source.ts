/**
 * 通过 EasyEDA 的 getGerberFile() 获取 PCB Gerber 打包 ZIP，
 * 解压后按 JLCPCB 命名规范归类到各层角色。
 */

import { createParser } from '@tracespace/parser';
import JSZip from 'jszip';

export type GerberLayerRole
	= | 'topCopper'
		| 'bottomCopper'
		| 'topSilk'
		| 'bottomSilk'
		| 'topMask'
		| 'bottomMask'
		| 'topPaste'
		| 'bottomPaste'
		| 'inner'
		| 'outline'
		| 'mechanical'
		| 'drill'
		| 'unknown';

export interface GerberLayerText {
	role: GerberLayerRole;
	layerName: string;
	color: string;
	filetype: 'gerber' | 'excellon';
	text: string;
	originalFilename: string;
}

interface EdaLayerItem {
	id: number;
	name: string;
	color: string;
	type: string;
}

declare const eda: {
	pcb_Layer: { getAllLayers: () => Promise<EdaLayerItem[]> };
	pcb_ManufactureData: {
		getGerberFile: (
			fileName?: string,
			colorSilkscreen?: boolean,
			unit?: 'mm' | 'inch' | 'mil' | 'in' | number,
			digitalFormat?: { integerNumber: number; decimalNumber: number },
			other?: {
				metallicDrillingInformation: boolean;
				nonMetallicDrillingInformation: boolean;
				drillTable: boolean;
				flyingProbeTestingFile: boolean;
			},
			layers?: Array<{ layerId: number; isMirror: boolean }>,
		) => Promise<File | null | undefined>;
	};
};

/** JLCPCB 命名规范 → 角色映射（按优先级：先匹配后缀大写） */
const EXT_TO_ROLE: Record<string, GerberLayerRole> = {
	GTL: 'topCopper',
	GBL: 'bottomCopper',
	GTS: 'topMask',
	GBS: 'bottomMask',
	GTO: 'topSilk',
	GBO: 'bottomSilk',
	GTP: 'topPaste',
	GBP: 'bottomPaste',
	GKO: 'outline',
	GML: 'mechanical',
	GTA: 'mechanical',
	GBB: 'mechanical',
	GDL: 'mechanical',
	GDD: 'mechanical',
	GCL: 'mechanical',
	// 钻孔（Excellon）
	DRL: 'drill',
	// 内层（.G1 ... .G32 视作内层；具体层号在前缀里记录）
};

/**
 * 从文件名中提取层信息。
 *  - `BoardName.GTL` → role=topCopper
 *  - `BoardName.G1`  → role=inner
 *  - `BoardName-2.GTL`（多板）→ 同上
 */
function classifyByFilename(name: string): GerberLayerRole {
	const base = name.split('/').pop() || name;
	const ext = base.split('.').pop()?.toUpperCase() || '';
	if (EXT_TO_ROLE[ext])
		return EXT_TO_ROLE[ext];
	if (/^G\d+$/.test(ext))
		return 'inner';
	// 自定义机械层：GM1..GM32
	if (/^GM\d+$/.test(ext))
		return 'mechanical';
	return 'unknown';
}

/** Excellon 钻孔文件第一条命令包含 M48 / FMAT / INCH / METRIC 这类关键字 */
function looksLikeDrill(text: string): boolean {
	if (!text)
		return false;
	const head = text.slice(0, 200).toUpperCase();
	return head.includes('M48') || head.includes('FMAT') || head.includes(';FILE_FORMAT=');
}

/**
 * Gerber 文件内容嗅探。
 * 支持标准头部（%FS / G04 / %MO / %IN）以及自定义层可能先出现的
 * D01/D02/D03 操作、%AD 光圈定义、X###Y### 坐标数据、M02 结束符。
 * Excellon 用 M48 / FMAT / ;FILE_FORMAT=，在这里排除。
 */
function looksLikeGerber(text: string): boolean {
	if (!text)
		return false;
	const head = text.slice(0, 8192).toUpperCase();
	if (head.includes('M48') || head.includes('FMAT') || head.includes(';FILE_FORMAT='))
		return false;
	if (head.includes('%FS') || head.includes('G04') || head.includes('%MO') || head.includes('%IN'))
		return true;
	if (head.includes('%AD') || head.includes('D01') || head.includes('D02') || head.includes('D03'))
		return true;
	if (/X\d+Y\d+/.test(head))
		return true;
	if (head.includes('M02'))
		return true;
	return false;
}

/** 用 tracespace parser 实际尝试解析；对内容特征不明显的自定义层做最后兜底。 */
function canParseAsGerber(text: string): boolean {
	if (!text || !text.trim())
		return false;
	try {
		const parser = createParser();
		parser.feed(text.slice(0, 65536));
		parser.result();
		return true;
	}
	catch {
		return false;
	}
}

/** 决定每个 role 的配色（取自 EDA 层表） */
function pickColor(layers: EdaLayerItem[], role: GerberLayerRole, originalFilename: string): { name: string; color: string } {
	const norm = (s: string) => s.toLowerCase().replace(/[_\s]+/g, '');
	const ext = (originalFilename.split('.').pop() || '').toLowerCase();
	const colorByRole: Record<GerberLayerRole, string> = {
		topCopper: '#ff0000',
		bottomCopper: '#0000ff',
		topSilk: '#ffcc00',
		bottomSilk: '#66cc33',
		topMask: '#800080',
		bottomMask: '#aa00ff',
		topPaste: '#808080',
		bottomPaste: '#800000',
		inner: '#888888',
		outline: '#ff00ff',
		mechanical: '#f022f0',
		drill: '#222222',
		unknown: '#888888',
	};
	const nameByRole: Record<GerberLayerRole, string> = {
		topCopper: 'Top Copper',
		bottomCopper: 'Bottom Copper',
		topSilk: 'Top Silkscreen',
		bottomSilk: 'Bottom Silkscreen',
		topMask: 'Top Solder Mask',
		bottomMask: 'Bottom Solder Mask',
		topPaste: 'Top Paste',
		bottomPaste: 'Bottom Paste',
		inner: 'Inner',
		outline: 'Board Outline',
		mechanical: 'Mechanical',
		drill: 'Drill',
		unknown: 'Unknown',
	};
	const matchLayer = layers.find((l) => {
		const n = norm(l.name);
		if (role === 'topCopper' && n.includes('top') && n.includes('copper'))
			return true;
		if (role === 'bottomCopper' && n.includes('bottom') && n.includes('copper'))
			return true;
		if (role === 'topSilk' && (n.includes('topsilk') || (n.includes('silkscreen') && n.includes('top'))))
			return true;
		if (role === 'bottomSilk' && (n.includes('bottomsilk') || (n.includes('silkscreen') && n.includes('bottom'))))
			return true;
		if (role === 'topMask' && n.includes('mask') && n.includes('top'))
			return true;
		if (role === 'bottomMask' && n.includes('mask') && n.includes('bottom'))
			return true;
		if (role === 'topPaste' && n.includes('paste') && n.includes('top'))
			return true;
		if (role === 'bottomPaste' && n.includes('paste') && n.includes('bottom'))
			return true;
		if (role === 'outline' && (n.includes('outline') || n === 'boardoutline'))
			return true;
		if (role === 'drill' && (n.includes('drill') || n.includes('hole')))
			return true;
		if (role === 'inner' && n.includes('inner')) {
			const m = /inner(\d+)/.exec(n);
			if (m && ext === `g${m[1]}`)
				return true;
		}
		return false;
	});
	if (matchLayer)
		return { name: matchLayer.name, color: matchLayer.color || colorByRole[role] };
	// mechanical / 自定义层没有匹配到 EDA 层表时，用文件名主干作为可读名称
	if (role === 'mechanical') {
		const stem = originalFilename.replace(/\.[^.]+$/, '').replace(/^Gerber_/i, '').replace(/[_-]+/g, ' ').trim();
		return { name: stem || nameByRole[role], color: colorByRole[role] };
	}
	return { name: nameByRole[role], color: colorByRole[role] };
}

/**
 * 主入口：调用 EDA 接口获取 Gerber ZIP，回填每个文件的层角色。
 */
export async function collectGerberSources(): Promise<GerberLayerText[]> {
	const layers = await eda.pcb_Layer.getAllLayers();
	// 默认调用按嘉立创生产需求导出；为兼容自定义层，优先尝试显式传入全部层 ID
	const layerParams = layers.map(l => ({ layerId: l.id, isMirror: false }));
	let file = await eda.pcb_ManufactureData.getGerberFile(
		undefined,
		undefined,
		'mm',
		{ integerNumber: 4, decimalNumber: 6 },
		{ metallicDrillingInformation: false, nonMetallicDrillingInformation: false, drillTable: false, flyingProbeTestingFile: false },
		layerParams,
	);
	if (!file) {
		console.log('[export-pcb-svg] gerber-source: all-layer export returned nothing, fallback to default');
		file = await eda.pcb_ManufactureData.getGerberFile(
			undefined,
			undefined,
			'mm',
			{ integerNumber: 4, decimalNumber: 6 },
		);
	}
	if (!file)
		throw new Error('EDA returned no Gerber file');
	const buf = await file.arrayBuffer();
	const zip = await JSZip.loadAsync(buf);
	const out: GerberLayerText[] = [];
	const skipped: Array<{ filename: string; reason: string }> = [];
	for (const entryName of Object.keys(zip.files)) {
		const entry = zip.files[entryName];
		if (entry.dir)
			continue;
		const filename = entryName.split('/').pop() || entryName;
		const upper = filename.toUpperCase();
		// JSON 文件直接跳过（FlyingProbeTesting 等 EDA 附属产物）
		if (upper.endsWith('.JSON')) {
			skipped.push({ filename, reason: 'json' });
			continue;
		}
		const isDrillExt = upper.endsWith('.DRL');
		const isTxtExt = upper.endsWith('.TXT');
		const text = await entry.async('string');
		if (!text || !text.trim()) {
			skipped.push({ filename, reason: 'empty' });
			continue;
		}
		// .TXT 既可能是 Excellon 也可能是说明文档，必须嗅探内容
		const contentIsDrill = looksLikeDrill(text);
		const contentIsGerber = looksLikeGerber(text);
		const parseable = contentIsGerber || contentIsDrill || canParseAsGerber(text);
		let role: GerberLayerRole;
		if (isDrillExt || (isTxtExt && contentIsDrill))
			role = 'drill';
		else
			role = classifyByFilename(filename);
		// 内容嗅探到 Excellon 但扩展名不在表里（如某些 EDA 把钻孔输出成 .XNC）
		if (role === 'unknown' && contentIsDrill)
			role = 'drill';
		// .TXT 既不是 Excellon 也不是 Gerber → 说明文档之类的，丢掉
		if (isTxtExt && !contentIsDrill && !contentIsGerber) {
			skipped.push({ filename, reason: 'txt-not-gerber' });
			continue;
		}
		// 既非 Gerber 也非 Excellon（纯文本 / JSON / 图像等），丢掉
		if (role === 'unknown' && !parseable) {
			skipped.push({ filename, reason: 'not-parseable' });
			continue;
		}
		const filetype: 'gerber' | 'excellon' = role === 'drill' || contentIsDrill ? 'excellon' : 'gerber';
		const { name, color } = pickColor(layers, role, filename);
		out.push({
			role,
			layerName: role === 'inner' ? `Inner${(filename.split('.').pop() || '').replace(/^G/i, '')}` : name,
			color,
			filetype,
			text,
			originalFilename: filename,
		});
	}
	console.log('[export-pcb-svg] gerber-source: included', out.map(l => l.originalFilename));
	console.log('[export-pcb-svg] gerber-source: skipped', skipped);

	// 同名层（如多份钻孔）追加原始文件名前缀，避免 .svg 重名覆盖
	const seen = new Map<string, number>();
	for (const layer of out) {
		const key = layer.layerName;
		const count = seen.get(key) ?? 0;
		if (count > 0) {
			const stem = layer.originalFilename.replace(/\.[^.]+$/, '').replace(/^Drill[_-]/i, '').replace(/^Gerber[_-]/i, '');
			layer.layerName = `${key} (${stem || `file${count}`})`;
		}
		seen.set(key, count + 1);
	}
	// 排序：顶层铜 → 底铜 → 内层 → 丝印 → 阻焊 → 钢网 → 边框 → 机械 → 钻孔
	const order: GerberLayerRole[] = [
		'topCopper',
		'bottomCopper',
		'inner',
		'topSilk',
		'bottomSilk',
		'topMask',
		'bottomMask',
		'topPaste',
		'bottomPaste',
		'outline',
		'mechanical',
		'drill',
		'unknown',
	];
	out.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
	return out;
}
