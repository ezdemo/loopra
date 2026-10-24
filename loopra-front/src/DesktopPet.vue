<template>
  <main class="desktop-pet" :class="{ ready: spritesheetUrl }">
    <PetSprite
      v-if="spritesheetUrl"
      :key="spriteKey"
      :spritesheet-url="spritesheetUrl"
      state="idle"
      :initial-size-index="sizeIndex"
      :initial-scale="scale"
      :bubble-text="serviceOffline ? OFFLINE_MESSAGE : replyBubble"
      external-drag
      @activate="openMainWindow"
      @scale-change="saveScale"
      @drag-move="moveWindow"
      @interactive-change="setInteractive"
      @close-request="closePet"
    />
  </main>
</template>

<script setup>
import {onBeforeUnmount, onMounted, ref} from 'vue'
import PetSprite from './components/PetSprite.vue'
import {petAPI} from './services/api'

const OFFLINE_MESSAGE = '服务端离线中…'

const spritesheetUrl = ref('')
const sizeIndex = ref(1)
const spriteKey = ref(0)
const activePetKey = ref('')
const replyBubble = ref('')
const serviceOffline = ref(false)
const scale = ref(null)
let refreshTimer = null
let replyTimer = null
let removeRefreshListener = null
let removeReplyListener = null

async function loadPet() {
  try {
    const response = await petAPI.getActive()
    const pet = response?.data
    if (!response?.success || !pet?.active || !(pet.spritesheetUrl || pet.spritesheetPath)) {
      spritesheetUrl.value = ''
      activePetKey.value = ''
      return
    }
    serviceOffline.value = false
    // 后端返回的相对路径需解析为完整 URL，桌面端 file:// 协议下才能加载（适配服务端端口）
    const url = petAPI.resolveUrl(pet.spritesheetUrl || pet.spritesheetPath)
    const petKey = pet.name || url
    if (activePetKey.value !== petKey) {
      activePetKey.value = petKey
      spritesheetUrl.value = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
      spriteKey.value++
    }
    if (typeof pet.sizeIndex === 'number') sizeIndex.value = pet.sizeIndex
    if (typeof pet.scale === 'number') scale.value = pet.scale
  } catch {
    serviceOffline.value = true
  }
}

function moveWindow(delta) {
  window.electronAPI?.desktopPet?.moveBy(delta)
}

function setInteractive(interactive) {
  window.electronAPI?.desktopPet?.setInteractive(interactive)
}

function openMainWindow() {
  window.electronAPI?.desktopPet?.activateMain()
}

async function saveScale(nextScale) {
  scale.value = nextScale
  try {
    await petAPI.savePosition({scale: nextScale})
  } catch {
  }
}

function closePet() {
  window.electronAPI?.desktopPet?.close()
}

onMounted(() => {
  window.electronAPI?.desktopPet?.setInteractive(false)
  loadPet()
  refreshTimer = setInterval(loadPet, 4000)
  removeRefreshListener = window.electronAPI?.desktopPet?.onRefresh(loadPet)
  removeReplyListener = window.electronAPI?.desktopPet?.onReply((text) => {
    if (!text) return
    replyBubble.value = text
    clearTimeout(replyTimer)
    replyTimer = setTimeout(() => { replyBubble.value = '' }, 8000)
  })
})

onBeforeUnmount(() => {
  window.electronAPI?.desktopPet?.setInteractive(true)
  if (refreshTimer) clearInterval(refreshTimer)
  clearTimeout(replyTimer)
  removeRefreshListener?.()
  removeReplyListener?.()
})
</script>

<style scoped>
:global(html),
:global(body),
:global(#app) {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent !important;
}

.desktop-pet {
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
  opacity: 0;
  transition: opacity 160ms ease;
}

.desktop-pet.ready {
  opacity: 1;
}
</style>
