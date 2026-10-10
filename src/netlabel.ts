/**
 * 网络标签采集与批量改名核心逻辑
 *
 * 实测结论（编辑器 V3.2.186 / 扩展API运行时 0.3.18）：
 *  - 电源/地标志(netflag)与网络端口(netport)是元件图元，网络名存在其子属性
 *    「Name」（netflag 另有「Global Net Name」）中；改名必须走
 *    sch_PrimitiveAttribute.modify(子属性ID, { value })——
 *    sch_PrimitiveComponent.modify 对这两类图元会抛错（仅元件(part)允许）。
 *  - 导线(wire)的网络名是图元自身的 net 属性，可用
 *    sch_PrimitiveWire.modify(id, { net }) 直接改。
 *  - 网络标签作为自由属性图元（key=NET）是 EDA v4 的模型
 *    （createNetLabel 标注 ADD since EDA v4），v3 调用会挂起；
 *    保留该路径仅为向前兼容，v3 图页上通常不存在。
 */

/** v4 网络标签属性图元的 key（大小写不敏感匹配） */
const NET_LABEL_KEYS = new Set(['NET']);

/** netflag/netport 中承载网络名的子属性 key */
const NAME_ATTR_KEY = 'NAME';
/** netflag 中与网络名同步的附加子属性 key */
const GLOBAL_NET_ATTR_KEY = 'GLOBAL NET NAME';

export interface KeyStats {
	key: string;
	count: number;
}

export type NetLabelKind = 'netflag' | 'netport' | 'wire' | 'netlabel';

export interface NetLabelItem {
	kind: NetLabelKind;
	/** netflag/netport/wire: 图元ID；netlabel: 属性图元ID（直接改 value） */
	primitiveId: string;
	/** netflag/netport: 承载网络名的「Name」子属性图元ID */
	attrId?: string;
	/** netflag: 需同步修改的附加子属性图元ID（Global Net Name） */
	syncAttrIds?: Array<string>;
	/** 当前网络名 */
	name: string;
}

export interface RenameOptions {
	find: string;
	replace: string;
	mode: 'plain' | 'regex';
	caseSensitive: boolean;
}

export interface RenamePlan {
	item: NetLabelItem;
	from: string;
	to: string;
}

export interface ApplyOutcome {
	okCount: number;
	failCount: number;
	failures: Array<{ from: string; to: string; reason: string }>;
}

async function safeGetAll(getter: () => Promise<unknown>): Promise<Array<any>> {
	try {
		const r = await getter();
		return Array.isArray(r) ? r : [];
	}
	catch {
		return [];
	}
}

/** 采集所有可改名的网络对象；同时返回未识别属性的 key 统计（诊断用） */
export async function collectNetLabels(): Promise<{ items: Array<NetLabelItem>; ignoredKeyStats: Array<KeyStats> }> {
	const items: Array<NetLabelItem> = [];
	const keyCount = new Map<string, number>();

	// 1) 自由属性图元（v4 网络标签；API 仅当前图页）
	for (const attr of await safeGetAll(() => eda.sch_PrimitiveAttribute.getAll())) {
		const key = String(attr.getState_Key() ?? '');
		const value = String(attr.getState_Value() ?? '');
		if (NET_LABEL_KEYS.has(key.toUpperCase())) {
			if (value)
				items.push({ kind: 'netlabel', primitiveId: attr.getState_PrimitiveId(), name: value });
		}
		else if (key) {
			keyCount.set(key, (keyCount.get(key) ?? 0) + 1);
		}
	}

	// 2) 电源/地标志与网络端口（元件图元，可跨图页）；网络名在其子属性中
	for (const [type, kind] of [[ESCH_PrimitiveComponentType.NET_FLAG, 'netflag'], [ESCH_PrimitiveComponentType.NET_PORT, 'netport']] as const) {
		for (const comp of await safeGetAll(() => eda.sch_PrimitiveComponent.getAll(type, true))) {
			let name = '';
			try {
				name = comp.getState_Net() ?? comp.getState_Name() ?? '';
			}
			catch {
				continue;
			}
			if (!name)
				continue;
			const pid = comp.getState_PrimitiveId();
			let attrId: string | undefined;
			let syncAttrIds: Array<string> | undefined;
			for (const kid of await safeGetAll(() => eda.sch_PrimitiveAttribute.getAll(pid))) {
				const kk = String(kid.getState_Key() ?? '').toUpperCase();
				if (!attrId && kk === NAME_ATTR_KEY)
					attrId = kid.getState_PrimitiveId();
				else if (kk === GLOBAL_NET_ATTR_KEY)
					(syncAttrIds ??= []).push(kid.getState_PrimitiveId());
			}
			items.push({ kind, primitiveId: pid, attrId, syncAttrIds, name });
		}
	}

	// 3) 导线的网络名（net 非空的导线；当前图页）
	for (const wire of await safeGetAll(() => eda.sch_PrimitiveWire.getAll())) {
		let net = '';
		try {
			net = String(wire.getState_Net?.() ?? '');
		}
		catch {
			continue;
		}
		if (net)
			items.push({ kind: 'wire', primitiveId: wire.getState_PrimitiveId(), name: net });
	}

	const ignoredKeyStats = [...keyCount.entries()]
		.map(([key, count]) => ({ key, count }))
		.sort((a, b) => b.count - a.count);

	return { items, ignoredKeyStats };
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ================= 写入后读回验证（应对旧版本运行时写入不落盘/返回值不可靠） ================= */

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function tryModifyAttr(attrId: string, value: string): Promise<void> {
	try {
		await eda.sch_PrimitiveAttribute.modify(attrId, { value });
	}
	catch { /* 忽略，由读回验证判定成败 */ }
}

/** 读回元件网络名（net 优先、name 兜底），带重试以容忍画布异步刷新 */
async function verifyComponentNet(primitiveId: string, expected: string, attempts = 3): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		try {
			const comp = await eda.sch_PrimitiveComponent.get(primitiveId);
			const cur = String(comp?.getState_Net?.() ?? comp?.getState_Name?.() ?? '');
			if (cur === expected)
				return true;
		}
		catch { /* 继续重试 */ }
		await sleep(250);
	}
	return false;
}

async function verifyWireNet(primitiveId: string, expected: string, attempts = 3): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		try {
			const wire = await eda.sch_PrimitiveWire.get(primitiveId);
			const cur = String(wire?.getState_Net?.() ?? '');
			if (cur === expected)
				return true;
		}
		catch { /* 继续重试 */ }
		await sleep(250);
	}
	return false;
}

async function verifyAttrValue(primitiveId: string, expected: string): Promise<boolean> {
	try {
		const attr = await eda.sch_PrimitiveAttribute.get(primitiveId);
		return String(attr?.getState_Value?.() ?? '') === expected;
	}
	catch {
		return false;
	}
}

/** 计算单个名称的新值；无需变更返回 null。plain 模式下替换文本按字面处理（$ 不解释为捕获组） */
export function computeNewName(name: string, opts: RenameOptions): string | null {
	let to: string;
	if (opts.mode === 'regex') {
		to = name.replace(new RegExp(opts.find, opts.caseSensitive ? 'g' : 'gi'), opts.replace);
	}
	else {
		const literalReplace = opts.replace.replaceAll('$', '$$');
		if (opts.caseSensitive) {
			to = name.split(opts.find).join(opts.replace);
		}
		else {
			to = name.replace(new RegExp(escapeRegExp(opts.find), 'gi'), literalReplace);
		}
	}
	return to === name ? null : to;
}

/** 依据替换选项生成改名计划；替换后为空白的条目被跳过并计数 */
export function buildRenamePlan(items: Array<NetLabelItem>, opts: RenameOptions): { plan: Array<RenamePlan>; skippedEmpty: number } {
	const plan: Array<RenamePlan> = [];
	let skippedEmpty = 0;
	for (const item of items) {
		const to = computeNewName(item.name, opts);
		if (to === null)
			continue;
		if (!to.trim()) {
			skippedEmpty++;
			continue;
		}
		plan.push({ item, from: item.name, to });
	}
	return { plan, skippedEmpty };
}

/** 逐条应用改名计划；每条写入后读回验证，未生效时自动切换写入路径重试 */
export async function applyRenamePlan(plan: Array<RenamePlan>): Promise<ApplyOutcome> {
	const outcome: ApplyOutcome = { okCount: 0, failCount: 0, failures: [] };
	for (const p of plan) {
		const tried: Array<string> = [];
		let ok = false;
		try {
			if (p.item.kind === 'netlabel') {
				await tryModifyAttr(p.item.primitiveId, p.to);
				ok = await verifyAttrValue(p.item.primitiveId, p.to);
				if (!ok)
					tried.push('属性value写入未生效');
			}
			else if (p.item.kind === 'wire') {
				try {
					await eda.sch_PrimitiveWire.modify(p.item.primitiveId, { net: p.to });
				}
				catch {
					tried.push('wire.modify抛错');
				}
				ok = await verifyWireNet(p.item.primitiveId, p.to);
				if (!ok)
					tried.push('导线net写入未生效');
			}
			else {
				// netflag/netport：依次尝试 Name 子属性 → Global Net Name 子属性 → 元件 name 修改
				// （不同版本运行时生效路径不同，以读回验证为准）
				if (p.item.attrId) {
					await tryModifyAttr(p.item.attrId, p.to);
					ok = await verifyComponentNet(p.item.primitiveId, p.to);
					if (!ok)
						tried.push('Name子属性未生效');
				}
				else {
					tried.push('无Name子属性');
				}
				if (!ok) {
					for (const sid of p.item.syncAttrIds ?? []) {
						await tryModifyAttr(sid, p.to);
						ok = await verifyComponentNet(p.item.primitiveId, p.to);
						if (ok)
							break;
						tried.push('GlobalNetName子属性未生效');
					}
				}
				if (!ok) {
					try {
						await eda.sch_PrimitiveComponent.modify(p.item.primitiveId, { name: p.to });
						ok = await verifyComponentNet(p.item.primitiveId, p.to);
						if (!ok)
							tried.push('component.name未生效');
					}
					catch {
						tried.push('component.name不可用');
					}
				}
			}
			if (ok) {
				outcome.okCount++;
				// 主路径成功后仍尽力同步「Global Net Name」（失败静默，不影响结果）
				if (p.item.kind === 'netflag' || p.item.kind === 'netport') {
					for (const sid of p.item.syncAttrIds ?? []) {
						await tryModifyAttr(sid, p.to);
					}
				}
			}
			else {
				outcome.failCount++;
				outcome.failures.push({ from: p.from, to: p.to, reason: `写入未生效（已尝试：${tried.join('、') || '无'}）` });
			}
		}
		catch (e) {
			outcome.failCount++;
			outcome.failures.push({ from: p.from, to: p.to, reason: e instanceof Error ? e.message : String(e) });
		}
	}
	return outcome;
}
