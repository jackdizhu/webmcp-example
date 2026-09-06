// Chrome LNA（Local Network Access，本地网络访问）权限检测。
//
// 背景：Chrome 142 起强制执行 LNA（受限请求需权限），147 起扩展到 WebSocket；
// chrome-extension:// origin 被归类为 public 地址空间，Service Worker 对
// ws://127.0.0.1:9333-9348 的 relay 探测属 public→loopback 跨界请求，会被
// Chrome 以 ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS 静默拦截。
//
// 关键约束：Service Worker 无弹窗 UI（官方文档明确要求 worker origin 的权限
// 必须预先授予），因此扩展侧无法触发授权弹窗，只能检测 + 引导用户手动授权：
//   chrome://extensions → 扩展详情 → 网站设置 → 本地网络访问 = 允许
//
// 权限名演进：Chrome 145 拆分为 local-network / loopback-network 两个细粒度权限，
// 旧名 local-network-access 作为兼容别名仍可在 Permissions.query 使用
// （别名查询返回两者组合状态：任一 denied 即 denied，见 MDN LNA 文档）。
// 本扩展只访问 loopback（127.0.0.1 / ::1），优先查询 loopback-network。

/** LNA loopback 权限状态；unsupported 表示运行环境不支持该权限查询。 */
export type LnaPermissionState = 'granted' | 'prompt' | 'denied' | 'unsupported';

/** 权限查询函数面（生产用 navigator.permissions；测试注入桩）。 */
export type LnaPermissionQuerier = () => Promise<LnaPermissionState>;

/** 查询优先级：145+ 细粒度名优先，142-144 兼容别名兜底。 */
const PERMISSION_NAMES = ['loopback-network', 'local-network-access'] as const;

/** Permissions API 最小面（跨环境安全取用，避免依赖 DOM lib 类型）。 */
interface PermissionsLike {
  query(description: { name: string }): Promise<{ state: string }>;
}

function getPermissions(): PermissionsLike | null {
  const nav = (globalThis as { navigator?: { permissions?: PermissionsLike } }).navigator;
  return nav?.permissions ?? null;
}

/** 单个权限名查询；名称未支持（TypeError）或非法 state 返回 null 以便回退。 */
async function queryByName(
  permissions: PermissionsLike,
  name: string
): Promise<LnaPermissionState | null> {
  try {
    const result = await permissions.query({ name });
    if (result.state === 'granted' || result.state === 'prompt' || result.state === 'denied') {
      return result.state;
    }
    return null;
  } catch {
    // Permissions API 不认识该名称（Chrome < 142 或非安全上下文）→ 尝试下一个
    return null;
  }
}

/**
 * 查询当前 origin 的 loopback（LNA）权限状态。
 * 返回顺序：首个可确定的结果（granted/prompt/denied）；全部名称未支持或
 * 环境无 Permissions API 时返回 'unsupported'（调用方应跳过 LNA 提示）。
 */
export async function queryLoopbackPermission(): Promise<LnaPermissionState> {
  const permissions = getPermissions();
  if (!permissions) {
    return 'unsupported';
  }
  for (const name of PERMISSION_NAMES) {
    const state = await queryByName(permissions, name);
    if (state !== null) {
      return state;
    }
  }
  return 'unsupported';
}
