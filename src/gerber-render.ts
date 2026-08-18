/**
 * 把 tracespace plotter 输出的 image-tree 转换为 SVG 字符串。
 *
 * 这里使用 @tracespace/renderer 渲染出 SVG 抽象树，再手动序列化为字符串。
 * 与 tracespace 官方渲染保持一致： Gerber Y 向上 → SVG Y 向下，
 * 通过直接对坐标取负实现，避免自定义路径拼接错误。
 */

import type { ImageTree } from '@tracespace/plotter';
import type { GerberLayerText } from './gerber-source.ts';
import type { PourGeom, PourNet } from './pour-net.ts';
import { createParser } from '@tracespace/parser';
import { plot } from '@tracespace/plotter';
import { render } from '@tracespace/renderer';
import { collectPourGeoms, MM2MIL, netAtPoint } from './pour-net.ts';

export interface RenderedSvg {
	filename: string;
	content: string;
	role: GerberLayerText['role'];
}

interface HastElement {
	type: 'element';
	tagName: string;
	properties?: Record<string, unknown>;
	children?: (HastElement | string)[];
}

const VOID_TAGS = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'param',
	'source',
	'track',
	'wbr',
	'circle',
	'ellipse',
	'line',
	'path',
	'polygon',
	'polyline',
	'rect',
	'stop',
]);

function escapeAttr(s: string): string {
	return s.replace(/[&<>"']/g, c => (
		{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' }[c]!
	));
}

const SPECIAL_ATTRS: Record<string, string> = {
	xmlnsXLink: 'xmlns:xlink',
	strokeLineCap: 'stroke-linecap',
	strokeLineJoin: 'stroke-linejoin',
	strokeWidth: 'stroke-width',
	fillRule: 'fill-rule',
	clipRule: 'clip-rule',
	viewBox: 'viewBox',
};

function propertyNameToAttr(name: string): string {
	if (SPECIAL_ATTRS[name])
		return SPECIAL_ATTRS[name];
	return name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
}

function propertiesToAttrs(properties: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(properties)) {
		if (value == null || value === false)
			continue;
		const attr = propertyNameToAttr(key);
		const v = value === true ? '' : String(value);
		parts.push(`${attr}="${escapeAttr(v)}"`);
	}
	return parts.join(' ');
}

function hastToXml(node: HastElement | string): string {
	if (typeof node === 'string')
		return escapeAttr(node);

	const { tagName, properties = {}, children = [] } = node;
	const attrs = propertiesToAttrs(properties);
	const open = attrs ? `<${tagName} ${attrs}` : `<${tagName}`;

	if (VOID_TAGS.has(tagName) && children.length === 0)
		return `${open}/>`;

	const inner = children.map(hastToXml).join('');
	return `${open}>${inner}</${tagName}>`;
}

function safeGerberFilename(name: string): string {
	const sanitized = name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Layer';
	return `${sanitized}.svg`;
}

/** 把 Gerber 文本分块喂给流式 parser，避免大文件一次 parse 爆栈 */
function parseGerberText(text: string) {
	const parser = createParser();
	const lines = text.split('\n');
	const CHUNK_LINES = 500;
	for (let i = 0; i < lines.length; i += CHUNK_LINES) {
		const chunk = lines.slice(i, i + CHUNK_LINES).join('\n');
		parser.feed(chunk);
	}
	return parser.result();
}

/** 铜皮画布层 id：topCopper=1, bottomCopper=2, innerN=14+N */
function copperCanvasLayerId(layer: GerberLayerText): number | null {
	if (layer.role === 'topCopper')
		return 1;
	if (layer.role === 'bottomCopper')
		return 2;
	if (layer.role === 'inner') {
		const m = /inner(\d+)/i.exec(layer.layerName) || /\.g(\d+)$/i.exec(layer.originalFilename);
		return m ? 14 + Number(m[1]) : null;
	}
	return null;
}

/**
 * 推导铺铜 complexPolygon 坐标系与画布 mil 坐标系之间的偏移量（纯平移）。
 *
 * 画布 mil = SVG(mm) × MM2MIL + 0（走线已验证无偏移）；而铺铜 complexPolygon 位于
 * 一个随板子变化的偏移坐标系里。这里用"铺铜包围盒中心 ↔ SVG 填充区域中心"的差做聚类：
 * 同一块板子上所有铺铜共享同一偏移，正确偏移跨铺铜重复出现，聚成主簇；错误配对则散乱。
 * 与脆弱的 getPrimitivesInRegion 无关，对单铺铜/多铺铜板子都可靠。
 *
 * 对每个铺铜，按包围盒尺寸（w/h）在 SVG imageRegion 中挑选最相似的一块，取其中心差。
 * 返回 null 表示无法推导（该板子某铜层无铺铜区域）。
 */
function derivePourOffset(
	rendered: Array<{ ok: boolean; layer: GerberLayerText; image: ImageTree } | { ok: false }>,
	poursByLayer: Map<number, PourGeom[]>,
): { dx: number; dy: number } | null {
	for (const r of rendered) {
		if (!r.ok)
			continue;
		const layerId = copperCanvasLayerId(r.layer);
		if (layerId === null)
			continue;
		const pours = poursByLayer.get(layerId) || [];
		if (pours.length === 0)
			continue;
		const regions = (r.image.children || []).filter(
			c => c && (c as { type?: string }).type === 'imageRegion',
		) as Array<{ segments?: Array<{ start: number[]; end: number[] }> }>;
		if (regions.length === 0)
			continue;

		const candidates: Array<[number, number]> = [];
		for (const p of pours) {
			if (!p.rect || p.rect.w <= 0 || p.rect.h <= 0)
				continue;
			const pcx = p.rect.x + p.rect.w / 2;
			const pcy = p.rect.y + p.rect.h / 2;
			let bestBb: [number, number, number, number] | null = null;
			let bestScore = Infinity;
			for (const reg of regions) {
				const bb = segmentsBBox(reg.segments || []);
				if (!bb)
					continue;
				const wMil = (bb[2] - bb[0]) * MM2MIL;
				const hMil = (bb[3] - bb[1]) * MM2MIL;
				// 尺寸需与铺铜 outline 同量级，避免把小铺铜误配到大区域
				if (wMil / p.rect.w < 0.4 || wMil / p.rect.w > 2.5)
					continue;
				if (hMil / p.rect.h < 0.4 || hMil / p.rect.h > 2.5)
					continue;
				const score = Math.abs(wMil - p.rect.w) + Math.abs(hMil - p.rect.h);
				if (score < bestScore) {
					bestScore = score;
					bestBb = bb;
				}
			}
			if (!bestBb)
				continue;
			const cx = ((bestBb[0] + bestBb[2]) / 2) * MM2MIL;
			const cy = ((bestBb[1] + bestBb[3]) / 2) * MM2MIL;
			candidates.push([cx - pcx, cy - pcy]);
		}
		if (candidates.length === 0)
			continue;

		const counts = new Map<string, number>();
		for (const [dx, dy] of candidates) {
			const key = `${Math.round(dx)},${Math.round(dy)}`;
			counts.set(key, (counts.get(key) || 0) + 1);
		}
		let bestKey: string | null = null;
		let bestCount = 0;
		for (const [k, c] of counts) {
			if (c > bestCount) {
				bestCount = c;
				bestKey = k;
			}
		}
		if (!bestKey)
			continue;
		const [dx, dy] = bestKey.split(',').map(Number);
		return { dx, dy };
	}
	return null;
}

/** 计算一系列线段点的包围盒 [minX, minY, maxX, maxY]（mm，Y 向上，与画布 mil Y 向上一致）。 */
function segmentsBBox(segments: Array<{ start: number[]; end: number[] }>): [number, number, number, number] | null {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const seg of segments) {
		for (const [x, y] of [seg.start, seg.end]) {
			if (x < minX)
				minX = x;
			if (x > maxX)
				maxX = x;
			if (y < minY)
				minY = y;
			if (y > maxY)
				maxY = y;
		}
	}
	if (minX === Infinity)
		return null;
	return [minX, minY, maxX, maxY];
}

/** 计算一系列线段点的包围盒中心（mm，Y 向上，与画布 mil Y 向上一致）。 */
function segmentsBBoxCenter(segments: Array<{ start: number[]; end: number[] }>): [number, number] {
	const bb = segmentsBBox(segments);
	return bb ? [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2] : [0, 0];
}

/** 取一个 image 节点用于画布命中测试的代表点（mm）。shape 类型见 @tracespace/plotter tree.ts。 */
function nodeRepPointMm(node: { type: string; segments?: Array<{ start: number[]; end: number[] }>; shape?: Record<string, unknown> }): [number, number] | null {
	if (node.type === 'imageRegion' || node.type === 'imagePath') {
		if (!node.segments || node.segments.length === 0)
			return null;
		return segmentsBBoxCenter(node.segments);
	}
	if (node.type === 'imageShape' && node.shape) {
		const s = node.shape as Record<string, number | number[] | Array<{ start: number[]; end: number[] }>>;
		switch (s.type) {
			case 'circle':
				return [s.cx as number, s.cy as number];
			case 'rectangle':
				return [s.x as number + (s.xSize as number) / 2, s.y as number + (s.ySize as number) / 2];
			case 'polygon': {
				const pts = s.points as number[][];
				const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
				const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
				return [cx, cy];
			}
			case 'outline':
				return segmentsBBoxCenter(s.segments as Array<{ start: number[]; end: number[] }>);
			default:
				return null;
		}
	}
	return null;
}

/**
 * 给铜皮层每个节点标注 net 属性（image.children 与 svg.children 一一对应）。
 * 对节点代表点（区域重心 / 图形中心 / 走线中点）调用画布命中网络。
 */
async function attachNets(
	image: ImageTree,
	svg: HastElement,
	layerId: number,
	pourById: Map<string, PourNet>,
	pourGeoms: PourGeom[],
	offset: { dx: number; dy: number },
): Promise<void> {
	const imageChildren = image.children;
	const svgChildren = svg.children;
	if (!Array.isArray(svgChildren))
		return;
	const n = Math.min(imageChildren.length, svgChildren.length);
	for (let i = 0; i < n; i++) {
		const node = imageChildren[i];
		if (!node)
			continue;
		const rep = nodeRepPointMm(node as { type: string; segments?: Array<{ start: number[]; end: number[] }>; shape?: Record<string, unknown> });
		if (!rep)
			continue;
		const [mmX, mmY] = rep;
		const net = await netAtPoint(mmX * MM2MIL, mmY * MM2MIL, {
			expectedLayerId: layerId,
			pourById,
			pourGeoms,
			offset,
		});
		if (!net)
			continue;
		const el = svgChildren[i] as HastElement;
		if (typeof el === 'object' && el.type === 'element') {
			el.properties = { ...(el.properties ?? {}), net };
		}
	}
}

/** 渲染一层为 image-tree + HastElement（不标注 net、不序列化）。解析/铺铜失败时返回错误 SVG。 */
async function renderLayerToTree(
	layer: GerberLayerText,
): Promise<{ ok: true; layer: GerberLayerText; image: ImageTree; svg: HastElement } | { ok: false; content: string; role: GerberLayerText['role']; filename: string }> {
	let tree;
	try {
		tree = parseGerberText(layer.text);
	}
	catch (e) {
		return {
			ok: false,
			filename: safeGerberFilename(layer.originalFilename),
			role: layer.role,
			content: `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 100 100"><text x="10" y="50" font-size="6">Parse error: ${escapeAttr(String((e as Error).message || e))}</text></svg>`,
		};
	}

	let image: ImageTree;
	try {
		image = plot(tree);
	}
	catch (e) {
		return {
			ok: false,
			filename: safeGerberFilename(layer.originalFilename),
			role: layer.role,
			content: `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 100 100"><text x="10" y="50" font-size="6">Plot error: ${escapeAttr(String((e as Error).message || e))}</text></svg>`,
		};
	}

	return { ok: true, layer, image, svg: render(image) as HastElement };
}

export interface RenderOptions {
	/** 是否把所有层合并到一个 SVG 中 */
	merge?: boolean;
	/** 需要水平镜像的层 originalFilename 集合 */
	mirrorLayerIds?: Set<string>;
}

function parseViewBox(vb: string | number[] | undefined): [number, number, number, number] | null {
	if (Array.isArray(vb)) {
		if (vb.length === 4 && vb.every(v => typeof v === 'number'))
			return vb as [number, number, number, number];
		return null;
	}
	if (typeof vb === 'string') {
		const nums = vb.trim().split(/\s+/).map(Number).filter(n => !Number.isNaN(n));
		if (nums.length === 4)
			return nums as [number, number, number, number];
	}
	return null;
}

function viewBoxString(vb: [number, number, number, number]): string {
	return `${vb[0]} ${vb[1]} ${vb[2]} ${vb[3]}`;
}

function combineViewBoxes(boxes: Array<[number, number, number, number]>): [number, number, number, number] | null {
	if (boxes.length === 0)
		return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y, w, h] of boxes) {
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x + w);
		maxY = Math.max(maxY, y + h);
	}
	return [minX, minY, maxX - minX, maxY - minY];
}

/** 把若干子节点包成一层，可选水平镜像。镜像绕该层中心线翻转。 */
function wrapLayerChildren(
	children: (HastElement | string)[],
	color: string,
	mirror: boolean,
	centerX: number,
): HastElement {
	const transform = mirror ? `translate(${2 * centerX}, 0) scale(-1, 1)` : undefined;
	const props: Record<string, unknown> = { style: `color:${escapeAttr(color)}` };
	if (transform)
		props.transform = transform;
	return { type: 'element', tagName: 'g', properties: props, children };
}

/**
 * 入口：渲染所有层。
 * 先渲染全部层并用"铺铜包围盒中心 ↔ SVG 填充区域中心"聚类推导 complexPolygon 偏移量，
 * 再给铜皮层标注 `net` 属性。
 * @param layers 各层 Gerber 文本
 * @param pourById 画布覆铜网络表（primitiveId → 网络），用于给铜皮区域标注 `net` 属性
 * @param opts 可选：merge 合并为一个 SVG；mirrorLayerIds 设置镜像层
 */
export async function renderGerberLayersToSvgs(
	layers: GerberLayerText[],
	pourById: Map<string, PourNet> = new Map(),
	opts: RenderOptions = {},
): Promise<RenderedSvg[]> {
	const rendered: Array<{ ok: true; layer: GerberLayerText; image: ImageTree; svg: HastElement } | { ok: false; content: string; role: GerberLayerText['role']; filename: string }> = [];
	for (let i = 0; i < layers.length; i++)
		rendered.push(await renderLayerToTree(layers[i]));

	// 用"铺铜包围盒中心 ↔ SVG 填充区域中心"聚类推导 complexPolygon 偏移量
	const pourGeoms = await collectPourGeoms();
	const poursByLayer = new Map<number, PourGeom[]>();
	for (const g of pourGeoms) {
		if (!poursByLayer.has(g.layer))
			poursByLayer.set(g.layer, []);
		poursByLayer.get(g.layer)!.push(g);
	}
	const offset = derivePourOffset(rendered, poursByLayer);

	const successItems = rendered.filter((r): r is { ok: true; layer: GerberLayerText; image: ImageTree; svg: HastElement } => r.ok);

	for (const r of successItems) {
		const { layer, image, svg } = r;
		const color = layer.color || '#888888';
		svg.properties = {
			...svg.properties,
			style: `color:${escapeAttr(color)}`,
		};

		const canvasLayerId = copperCanvasLayerId(layer);
		if (canvasLayerId !== null && offset)
			await attachNets(image, svg, canvasLayerId, pourById, pourGeoms, offset);
	}

	if (opts.merge)
		return [renderMergedSvg(successItems, opts.mirrorLayerIds || new Set())];

	const out: RenderedSvg[] = [];
	for (const r of rendered) {
		if (!r.ok) {
			out.push({ filename: r.filename, role: r.role, content: r.content });
			continue;
		}
		out.push(renderSingleSvg(r.layer, r.svg, opts.mirrorLayerIds || new Set()));
	}
	return out;
}

function renderSingleSvg(layer: GerberLayerText, svg: HastElement, mirrorIds: Set<string>): RenderedSvg {
	const vb = parseViewBox(svg.properties?.viewBox);
	const shouldMirror = mirrorIds.has(layer.originalFilename);
	if (shouldMirror && vb) {
		const centerX = vb[0] + vb[2] / 2;
		svg.children = [wrapLayerChildren(svg.children || [], layer.color || '#888888', true, centerX)];
	}
	const xml = hastToXml(svg);
	return {
		filename: safeGerberFilename(layer.originalFilename),
		role: layer.role,
		content: `<?xml version="1.0" encoding="UTF-8"?>\n${xml}\n`,
	};
}

function renderMergedSvg(
	items: Array<{ layer: GerberLayerText; svg: HastElement }>,
	mirrorIds: Set<string>,
): RenderedSvg {
	const viewBoxes: Array<[number, number, number, number]> = [];
	for (const { svg } of items) {
		const vb = parseViewBox(svg.properties?.viewBox);
		if (vb)
			viewBoxes.push(vb);
	}
	const combinedVb = combineViewBoxes(viewBoxes) || [0, 0, 100, 100];
	const centerX = combinedVb[0] + combinedVb[2] / 2;

	const groups: (HastElement | string)[] = [];
	for (const { layer, svg } of items) {
		const color = layer.color || '#888888';
		const shouldMirror = mirrorIds.has(layer.originalFilename);
		groups.push(wrapLayerChildren(svg.children || [], color, shouldMirror, centerX));
	}

	const mergedSvg: HastElement = {
		type: 'element',
		tagName: 'svg',
		properties: {
			xmlns: 'http://www.w3.org/2000/svg',
			version: '1.1',
			viewBox: viewBoxString(combinedVb),
			fill: 'currentColor',
			stroke: 'currentColor',
			strokeLineCap: 'round',
			strokeLineJoin: 'round',
			strokeWidth: '0',
			fillRule: 'evenodd',
			clipRule: 'evenodd',
		},
		children: groups,
	};

	return {
		filename: 'Merged.svg',
		role: 'unknown',
		content: `<?xml version="1.0" encoding="UTF-8"?>\n${hastToXml(mergedSvg)}\n`,
	};
}
