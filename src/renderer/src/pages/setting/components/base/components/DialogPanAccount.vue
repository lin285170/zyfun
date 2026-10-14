<template>
  <t-dialog
    v-model:visible="formVisible"
    show-in-attached-element
    :attach="`.${attachContent}`"
    placement="center"
    destroy-on-close
    lazy
    :footer="false"
    width="560px"
  >
    <template #header>
      <span>网盘账号</span>
    </template>
    <template #body>
      <div class="pan-account view-container">
        <t-alert theme="info" :bordered="false" style="margin-bottom: 12px">
          扫码登录后会自动保存 Cookie；也可展开手动填写。Cookie 仅存于本机。
        </t-alert>

        <div v-for="row in rows" :key="row.driver" class="pan-row">
          <div class="pan-row-head">
            <div class="pan-row-name">
              <span class="name">{{ row.name || row.driver }}</span>
              <t-tag v-if="row.hasCredential" theme="success" variant="light" size="small">已配置</t-tag>
              <t-tag v-else theme="default" variant="light" size="small">未配置</t-tag>
              <t-tag v-if="row.ok === true" theme="success" variant="outline" size="small">可用</t-tag>
              <t-tag v-else-if="row.ok === false" theme="danger" variant="outline" size="small">不可用</t-tag>
            </div>
            <div class="pan-row-actions">
              <t-button
                v-if="supportsQr(row.driver)"
                size="small"
                theme="primary"
                variant="outline"
                :loading="loadingQr === row.driver"
                @click="onScan(row.driver)"
              >
                扫码登录
              </t-button>
              <t-button
                v-if="row.hasCredential"
                size="small"
                variant="outline"
                :loading="checking === row.driver"
                @click="onCheck(row.driver)"
              >
                检测
              </t-button>
              <t-button
                v-if="row.hasCredential"
                size="small"
                theme="danger"
                variant="outline"
                @click="onRemove(row.driver)"
              >
                删除
              </t-button>
              <t-button size="small" variant="text" @click="toggleEdit(row.driver)">
                {{ editing === row.driver ? '收起' : '手动填写' }}
              </t-button>
            </div>
          </div>

          <div v-if="editing === row.driver" class="pan-row-edit">
            <t-textarea
              v-model="editValue[row.driver]"
              :autosize="{ minRows: 3, maxRows: 6 }"
              :placeholder="row.driver === 'baidu' ? 'BDUSS=xxx; STOKEN=xxx; BAIDUID=xxx' : '__pus=xxx; __puus=xxx'"
            />
            <div class="edit-actions">
              <t-button size="small" theme="primary" :loading="saving === row.driver" @click="onSave(row.driver)">
                保存
              </t-button>
            </div>
          </div>
        </div>

        <!-- 扫码区 -->
        <t-dialog
          v-model:visible="qrVisible"
          header="扫码登录"
          placement="center"
          :attach="`.${attachContent}`"
          :footer="false"
          width="320px"
          destroy-on-close
        >
          <div class="qr-box">
            <img v-if="qrImage" :src="qrImage" alt="二维码" class="qr-img" />
            <div v-else class="qr-placeholder">二维码加载中…</div>
            <div class="qr-status" :class="`st-${qrStatus}`">{{ qrText }}</div>
            <div v-if="qrHint" class="qr-hint">{{ qrHint }}</div>
            <t-button size="small" variant="outline" style="margin-top: 10px" @click="closeQr">关闭</t-button>
          </div>
        </t-dialog>
      </div>
    </template>
  </t-dialog>
</template>

<script setup lang="ts">
import { MessagePlugin } from 'tdesign-vue-next';
import { computed, ref, watch } from 'vue';

import {
  cancelPanQr,
  checkPanCredential,
  createPanQr,
  fetchPanCredentials,
  fetchPanDrivers,
  pollPanQr,
  removePanCredential,
  savePanCredential,
} from '@/api/pan';
import { attachContent } from '@/config/global';

defineOptions({
  name: 'SettingBaseDialogPanAccount',
});

const formVisible = defineModel<boolean>('visible', { default: false });

interface IRow {
  driver: string;
  name?: string;
  hasCredential?: boolean;
  ok?: boolean | null;
}
const rows = ref<IRow[]>([]);
const editing = ref('');
const editValue = ref<Record<string, string>>({});
const saving = ref('');
const checking = ref('');
const loadingQr = ref('');

/** 支持扫码的驱动（与后端 qrlogin.supports 保持一致） */
const supportsQr = (d: string) => d === 'baidu';

async function load() {
  const [dRes, cRes] = await Promise.all([fetchPanDrivers(), fetchPanCredentials()]);
  const drivers: Array<{ id: string; name: string }> = (dRes as any)?.data ?? [];
  const creds: any[] = (cRes as any)?.data ?? [];
  const byId = new Map(creds.map((c) => [c.driver, c]));
  rows.value = drivers.map((d) => {
    const c = byId.get(d.id) as any;
    return { driver: d.id, name: d.name, hasCredential: !!c?.hasCredential, ok: null };
  });
}

watch(formVisible, (v) => {
  if (v) {
    load().catch(() => {});
    editing.value = '';
    qrVisible.value = false;
  } else {
    closeQr();
  }
});

function toggleEdit(driver: string) {
  editing.value = editing.value === driver ? '' : driver;
  if (editing.value && !editValue.value[driver]) editValue.value[driver] = '';
}

async function onSave(driver: string) {
  const cookie = (editValue.value[driver] ?? '').trim();
  if (!cookie) {
    MessagePlugin.warning('请填写 Cookie');
    return;
  }
  saving.value = driver;
  try {
    await savePanCredential({ driver, cookie, enabled: true });
    MessagePlugin.success('已保存');
    editing.value = '';
    editValue.value[driver] = '';
    await load();
    await onCheck(driver);
  } catch (e) {
    MessagePlugin.error(`保存失败：${String(e)}`);
  } finally {
    saving.value = '';
  }
}

async function onCheck(driver: string) {
  checking.value = driver;
  try {
    const res: any = await checkPanCredential(driver);
    const ok = !!res?.data?.ok;
    const row = rows.value.find((r) => r.driver === driver);
    if (row) row.ok = ok;
    ok ? MessagePlugin.success('凭据可用') : MessagePlugin.warning('凭据不可用或已过期');
  } catch (e) {
    MessagePlugin.error(`检测失败：${String(e)}`);
  } finally {
    checking.value = '';
  }
}

async function onRemove(driver: string) {
  try {
    await removePanCredential(driver);
    MessagePlugin.success('已删除');
    await load();
  } catch (e) {
    MessagePlugin.error(`删除失败：${String(e)}`);
  }
}

/* ---------------- 扫码 ---------------- */
const qrVisible = ref(false);
const qrImage = ref('');
const qrStatus = ref<string>('waiting');
const qrHint = ref('');
const qrId = ref('');
let qrTimer: ReturnType<typeof setTimeout> | null = null;
let qrCancelled = false;

const qrText = computed(() => {
  switch (qrStatus.value) {
    case 'waiting':
      return '等待扫码…';
    case 'scanned':
      return '已扫码，请在手机上确认';
    case 'confirmed':
      return '登录成功';
    case 'expired':
      return '二维码已过期';
    case 'failed':
      return '登录失败';
    default:
      return '';
  }
});

function stopQrTimer() {
  if (qrTimer) {
    clearTimeout(qrTimer);
    qrTimer = null;
  }
}

function closeQr() {
  qrCancelled = true;
  stopQrTimer();
  if (qrId.value) cancelPanQr(qrId.value).catch(() => {});
  qrId.value = '';
  qrVisible.value = false;
  qrImage.value = '';
  qrStatus.value = 'waiting';
  qrHint.value = '';
}

async function onScan(driver: string) {
  loadingQr.value = driver;
  qrCancelled = false;
  try {
    const res: any = await createPanQr(driver);
    const d = res?.data;
    if (!d?.qrId) {
      MessagePlugin.warning(d?.hint || '该网盘暂不支持扫码登录，请手动填写 Cookie');
      return;
    }
    qrId.value = d.qrId;
    qrImage.value = d.image;
    qrHint.value = d.hint || '';
    qrStatus.value = 'waiting';
    qrVisible.value = true;
    loopPoll();
  } catch (e) {
    MessagePlugin.error(`获取二维码失败：${String(e)}`);
  } finally {
    loadingQr.value = '';
  }
}

function loopPoll() {
  if (qrCancelled || !qrId.value || !qrVisible.value) return;
  stopQrTimer();
  qrTimer = setTimeout(async () => {
    try {
      const res: any = await pollPanQr(qrId.value, true);
      const d = res?.data ?? {};
      qrStatus.value = d.status || 'waiting';
      if (d.message) qrHint.value = d.message;

      if (d.status === 'confirmed') {
        MessagePlugin.success('扫码登录成功，Cookie 已保存');
        qrId.value = '';
        await load();
        setTimeout(() => (qrVisible.value = false), 1200);
        return;
      }
      if (d.status === 'expired' || d.status === 'failed') {
        qrId.value = '';
        return;
      }
      loopPoll();
    } catch {
      // 单次失败不终止，继续轮询（长轮询超时属正常）
      loopPoll();
    }
  }, 1200);
}
</script>

<style scoped lang="less">
.pan-account {
  max-height: 60vh;
  overflow-y: auto;

  .pan-row {
    border: 1px solid var(--td-component-stroke);
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 10px;

    &-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }

    &-name {
      display: flex;
      align-items: center;
      gap: 8px;

      .name {
        font-weight: 500;
      }
    }

    &-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    &-edit {
      margin-top: 10px;

      .edit-actions {
        margin-top: 8px;
        display: flex;
        justify-content: flex-end;
      }
    }
  }
}

.qr-box {
  display: flex;
  flex-direction: column;
  align-items: center;

  .qr-img {
    width: 245px;
    height: 245px;
    image-rendering: pixelated;
  }

  .qr-placeholder {
    width: 245px;
    height: 245px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--td-bg-color-container-hover);
    border-radius: 8px;
    color: var(--td-text-color-placeholder);
  }

  .qr-status {
    margin-top: 10px;
    font-size: 14px;

    &.st-waiting {
      color: var(--td-text-color-secondary);
    }
    &.st-scanned {
      color: var(--td-warning-color);
    }
    &.st-confirmed {
      color: var(--td-success-color);
    }
    &.st-expired,
    &.st-failed {
      color: var(--td-error-color);
    }
  }

  .qr-hint {
    margin-top: 6px;
    font-size: 12px;
    color: var(--td-text-color-placeholder);
    text-align: center;
  }
}
</style>
