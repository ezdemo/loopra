<template>
  <SplashScreen @ready="onReady" @error="onError" @attention="onAttention" />
</template>

<script setup>
import SplashScreen from './components/SplashScreen.vue'

// Prepare the service in the background while the workspace shows placeholders.
// Surface this window only for installation or startup errors.
async function onReady() {
  try {
    await window.electronAPI?.splash?.ready()
  } catch (error) {
    console.error('[DesktopSplash] failed to notify ready:', error)
  }
}

function onError(error) {
  // SplashScreen 内部已展示错误界面（重试 / 一键安装 / 退出），此处仅记录
  console.error('[DesktopSplash] startup failed:', error)
  void onAttention()
}

async function onAttention() {
  await window.electronAPI?.splash?.show()
}
</script>
