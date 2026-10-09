/**
 * 原理图网络工具箱 扩展入口
 *
 * 菜单（仅原理图环境显示）：
 *  - 批量修改网络标签名称：打开可视化面板（查找/替换 双按钮：查找列出全部匹配，替换直接执行）
 *  - 列出网络标签：只读诊断对话框（按网络聚合列出全部对象）
 *
 * 架构说明：扩展沙箱无 window/localStorage/document（实测），无法从扩展向面板注入桥接；
 * 面板（iframe/net-tools.html）为自包含实现，直接经主窗口的 _EXTAPI_ROOT_
 * （EasyEDA API Gateway 扩展注入）调用编辑器 API。若该全局缺失，面板会显示降级提示。
 *
 * 安全语义：改名不自动保存工程，执行完由用户检查后手动保存。
 */
import extensionConfig from '../extension.json' with { type: 'json' };
import { collectNetLabels } from './netlabel';
import { info } from './ui';

export function activate(_status?: 'onStartupFinished', _arg?: string): void {}

export function about(): void {
	info(
		`原理图网络工具箱 v${extensionConfig.version}\n\n`
		+ '当前功能：批量修改网络标签名称（可视化面板）\n'
		+ '支持对象：电源/地标志、网络端口（跨图页）、导线网络名（当前图页）\n\n'
		+ '改名不会自动保存工程，请在执行后检查画布并手动保存。',
		'关于',
	);
}

const KIND_NAME: Record<string, string> = { netflag: '电源地', netport: '端口', wire: '导线', netlabel: '标签' };

/** 菜单：列出网络标签（只读诊断对话框） */
export async function listNetLabels(): Promise<void> {
	const { items, ignoredKeyStats } = await collectNetLabels();
	if (items.length === 0) {
		info('未找到网络对象。\n\n请确认已打开原理图图页；若刚放置，请等待画布刷新后重试。', '列出网络标签');
		return;
	}
	const groups = new Map<string, number>();
	for (const it of items) {
		const k = `${KIND_NAME[it.kind] ?? it.kind}\t${it.name}`;
		groups.set(k, (groups.get(k) ?? 0) + 1);
	}
	const lines = [...groups.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.slice(0, 40)
		.map(([k, n]) => {
			const [kind, name] = k.split('\t');
			return n > 1 ? `[${kind}] ${name} ×${n}` : `[${kind}] ${name}`;
		});
	const more = groups.size > 40 ? `\n…（其余 ${groups.size - 40} 组省略）` : '';
	const ignored = ignoredKeyStats.length > 0
		? `\n\n未识别为网络标签的属性 key 分布：${ignoredKeyStats.slice(0, 6).map(s => `${s.key}×${s.count}`).join('、')}`
		: '';
	info(`共 ${items.length} 个网络图元（按网络聚合）：\n\n${lines.join('\n')}${more}${ignored}`, '列出网络标签');
}

/** 菜单：批量修改网络标签名称（打开可视化面板） */
export async function batchRenameNetLabels(): Promise<void> {
	try {
		const opened = await eda.sys_IFrame.openIFrame(
			'/iframe/net-tools.html',
			480,
			520,
			'schNetToolsPanel',
			{ title: '批量修改网络标签' },
		);
		if (!opened)
			throw new Error('openIFrame 返回失败');
	}
	catch (e) {
		info(
			'打开面板失败：' + (e instanceof Error ? e.message : String(e))
			+ '\n\n如反复出现，请在扩展管理器中检查本扩展的「允许外部交互」权限。',
			'批量修改网络标签',
		);
	}
}
