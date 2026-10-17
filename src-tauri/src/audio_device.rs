//! Windows 音频输出端点监听
//!
//! 背景:
//!   Web Audio API 的输出始终跟随系统默认播放设备. 当蓝牙耳机/头戴设备断开时,
//!   Windows 会把默认输出切回扬声器, 但 AudioContext 不会因此停止,
//!   表现为"断开蓝牙后依旧在后台偷跑播歌".
//!
//! 方案:
//!   通过 IMMNotificationClient 订阅 Windows 音频端点通知. 每次收到通知后重新枚举
//!   "当前活跃的渲染(播放)设备"与"当前默认渲染设备", 与上一次快照做差集:
//!   只要本次消失的设备曾经是默认输出设备, 就向前端 emit
//!   `audio://output-device-removed`, 由 audioStore 触发自动暂停.
//!
//! 顺序兼容:
//!   断开蓝牙时, 系统可能先发"默认设备已切换", 再发"设备已移除". 因此除了与
//!   上一次默认设备求交, 还维护一个 retired_defaults 集合, 记录"曾是默认、之后
//!   被切走"的设备, 保证两种通知顺序都能命中.
//!
//! 说明: 完整的实现只在 Windows 编译 (见 main.rs 中的 cfg 调用).

use std::collections::HashSet;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};
use windows::core::{implement, PCWSTR, PWSTR};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Media::Audio::{
    eConsole, eMultimedia, eRender, EDataFlow, ERole, IMMDeviceCollection, IMMDeviceEnumerator,
    IMMNotificationClient, IMMNotificationClient_Impl, MMDeviceEnumerator, DEVICE_STATE,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};

/// 上一次观测到的设备快照
struct Snapshot {
    /// 当前处于 ACTIVE 状态的渲染(播放)设备 ID
    active: HashSet<String>,
    /// 当前默认渲染设备 ID (eConsole / eMultimedia 两个角色)
    defaults: HashSet<String>,
    /// 曾经是默认、之后不再担任默认的设备 ID
    /// (覆盖"先切默认、后移除设备"的通知顺序)
    retired_defaults: HashSet<String>,
}

/// 全局唯一快照 (进程级单例)
static SNAPSHOT: Mutex<Option<Snapshot>> = Mutex::new(None);

/// 复制 PWSTR 内容为 String, 并释放 COM 分配的内存
fn take_id(pwstr: PWSTR) -> String {
    let value = unsafe { pwstr.to_string() }.unwrap_or_default();
    if !pwstr.is_null() {
        unsafe { CoTaskMemFree(Some(pwstr.0 as *const core::ffi::c_void)) };
    }
    value
}

/// 枚举当前所有 ACTIVE 的渲染设备 ID
fn collect_active_render(enumerator: &IMMDeviceEnumerator) -> HashSet<String> {
    let mut ids = HashSet::new();
    let collection: IMMDeviceCollection =
        match unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) } {
            Ok(collection) => collection,
            Err(_) => return ids,
        };

    let count = unsafe { collection.GetCount() }.unwrap_or(0);
    for index in 0..count {
        let Ok(device) = (unsafe { collection.Item(index) }) else {
            continue;
        };
        let Ok(pwstr) = (unsafe { device.GetId() }) else {
            continue;
        };
        let id = take_id(pwstr);
        if !id.is_empty() {
            ids.insert(id);
        }
    }
    ids
}

/// 枚举当前默认渲染设备 ID (eConsole + eMultimedia)
fn collect_default_render(enumerator: &IMMDeviceEnumerator) -> HashSet<String> {
    let mut ids = HashSet::new();
    for role in [eConsole, eMultimedia] {
        let Ok(device) = (unsafe { enumerator.GetDefaultAudioEndpoint(eRender, role) }) else {
            continue;
        };
        let Ok(pwstr) = (unsafe { device.GetId() }) else {
            continue;
        };
        let id = take_id(pwstr);
        if !id.is_empty() {
            ids.insert(id);
        }
    }
    ids
}

/// 重新采样设备状态并与上次快照对账, 必要时通知前端
fn reconcile(app: &AppHandle) {
    // 回调线程未必初始化过 COM; 已初始化时会返回 RPC_E_CHANGED_MODE, 忽略即可
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };

    let enumerator: IMMDeviceEnumerator = match unsafe {
        CoCreateInstance(
            &MMDeviceEnumerator,
            None::<&windows::core::IUnknown>,
            CLSCTX_ALL,
        )
    } {
        Ok(enumerator) => enumerator,
        Err(_) => return,
    };

    let active = collect_active_render(&enumerator);
    let defaults = collect_default_render(&enumerator);

    let should_notify = {
        let mut guard = SNAPSHOT.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_mut() {
            // 首次采样: 只建立基线, 不触发暂停
            None => {
                *guard = Some(Snapshot {
                    active,
                    defaults,
                    retired_defaults: HashSet::new(),
                });
                false
            }
            Some(snapshot) => {
                // 本次消失的设备
                let removed: Vec<String> = snapshot.active.difference(&active).cloned().collect();
                // 不再担任默认的设备先标记为 retired (应对"先切默认、后移除"的顺序)
                let retired: Vec<String> =
                    snapshot.defaults.difference(&defaults).cloned().collect();
                for id in retired {
                    snapshot.retired_defaults.insert(id);
                }
                // 消失的设备只要曾经是默认设备, 就认为正在使用的输出设备断了
                let notify = removed
                    .iter()
                    .any(|id| snapshot.retired_defaults.contains(id));
                // 已经不活跃的设备不再保留 retired 记录, 避免集合无限增长
                snapshot.retired_defaults.retain(|id| active.contains(id));
                snapshot.active = active;
                snapshot.defaults = defaults;
                notify
            }
        }
    };

    if should_notify {
        let _ = app.emit("audio://output-device-removed", ());
    }
}

/// COM 通知回调: 只负责触发一次状态对账
#[implement(IMMNotificationClient)]
struct DeviceWatcher {
    app: AppHandle,
}

impl DeviceWatcher {
    fn refresh(&self) {
        reconcile(&self.app);
    }
}

impl IMMNotificationClient_Impl for DeviceWatcher_Impl {
    fn OnDeviceStateChanged(
        &self,
        _device_id: &PCWSTR,
        _new_state: DEVICE_STATE,
    ) -> windows::core::Result<()> {
        self.refresh();
        Ok(())
    }

    fn OnDeviceAdded(&self, _device_id: &PCWSTR) -> windows::core::Result<()> {
        self.refresh();
        Ok(())
    }

    fn OnDeviceRemoved(&self, _device_id: &PCWSTR) -> windows::core::Result<()> {
        self.refresh();
        Ok(())
    }

    fn OnDefaultDeviceChanged(
        &self,
        _flow: EDataFlow,
        _role: ERole,
        _default_device_id: &PCWSTR,
    ) -> windows::core::Result<()> {
        self.refresh();
        Ok(())
    }

    fn OnPropertyValueChanged(
        &self,
        _device_id: &PCWSTR,
        _key: &PROPERTYKEY,
    ) -> windows::core::Result<()> {
        Ok(())
    }
}

/// 启动输出设备监听 (由 main.rs setup 调用一次)
pub fn start(app: AppHandle) {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };

    let enumerator: IMMDeviceEnumerator = match unsafe {
        CoCreateInstance(
            &MMDeviceEnumerator,
            None::<&windows::core::IUnknown>,
            CLSCTX_ALL,
        )
    } {
        Ok(enumerator) => enumerator,
        Err(e) => {
            eprintln!("[audio_device] 创建 IMMDeviceEnumerator 失败: {e}");
            return;
        }
    };

    // 先建立一次基线快照, 避免把启动时已存在的设备误判成"刚移除"
    reconcile(&app);

    let client: IMMNotificationClient = DeviceWatcher { app }.into();
    if let Err(e) = unsafe { enumerator.RegisterEndpointNotificationCallback(&client) } {
        eprintln!("[audio_device] 注册音频端点通知失败: {e}");
        return;
    }

    // 监听必须持续到进程结束: 枚举器是通知来源, client 由系统持有引用计数.
    // 这里刻意泄漏 (进程级单例, 生命周期与应用一致), 避免被提前释放.
    core::mem::forget(enumerator);
    core::mem::forget(client);
}
