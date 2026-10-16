<template>
  <div class="reasoning-selector">
    <button class="selector-button" type="button" @click="toggle">
      <span class="effort-label">{{ selected.label }}</span>
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div v-if="open" class="reasoning-menu" :style="{'--progress': `${progress}%`}">
      <div class="summary"><strong>{{ selected.label }}<small class="effort-en">{{ selected.en }}</small></strong><span>{{ selected.description }}</span></div>
      <div class="track"><input v-model.number="index" aria-label="思考强度" type="range" min="0" max="4" step="1" @change="commit" /></div>
      <div class="levels"><button v-for="(option, optionIndex) in options" :key="option.value" type="button" :class="{active: optionIndex === index}" @click="pick(optionIndex)">{{ option.label }}<small class="effort-level-en">{{ option.en }}</small></button></div>
    </div>
  </div>
</template>

<script setup>
import {computed, ref, watch} from 'vue'

const props = defineProps({modelValue: {type: String, default: 'max'}})
const emit = defineEmits(['update:modelValue', 'open'])
const open = ref(false)
const options = [{value:'none', label:'无', en:'none', description:'直接响应'}, {value:'low', label:'低', en:'low', description:'快速响应'}, {value:'medium', label:'中', en:'medium', description:'速度与深度兼顾'}, {value:'high', label:'高', en:'high', description:'更充分地思考'}, {value:'max', label:'最大', en:'max', description:'优先获得最完整的推理'}]
const index = ref(4)
const selected = computed(() => options[index.value])
const progress = computed(() => index.value / (options.length - 1) * 100)
watch(() => props.modelValue, value => { const next = options.findIndex(option => option.value === value); index.value = next === -1 ? 4 : next }, {immediate:true})
const toggle = () => { open.value = !open.value; if (open.value) emit('open') }
const commit = () => { open.value = false; if (selected.value.value !== props.modelValue) emit('update:modelValue', selected.value.value) }
const pick = (nextIndex) => { index.value = nextIndex; commit() }
defineExpose({close: () => { open.value = false }})
</script>

<style scoped>
.reasoning-selector { position:relative; display:inline-flex; }.selector-button { display:flex; align-items:center; gap:4px; padding:2px 6px; border:0; border-radius:var(--r-sm); background:none; color:var(--fg-2); font:600 12px var(--sans); cursor:pointer; }.selector-button:hover {background:var(--bg-3)}.selector-button svg {color:var(--fg-4)}.effort-label {display:inline-grid;width:2em;place-items:center}.reasoning-menu {position:absolute;right:0;bottom:calc(100% + 8px);z-index:100;width:min(290px,calc(100vw - 28px));padding:12px;border:1px solid color-mix(in srgb,var(--accent) 38%,var(--border));border-radius:var(--r);background:linear-gradient(135deg,var(--bg),color-mix(in srgb,var(--accent) 7%,var(--bg)));box-shadow:var(--shadow),0 12px 28px color-mix(in srgb,var(--accent) 13%,transparent)}.summary {display:flex;justify-content:space-between;gap:10px;margin-bottom:11px;color:var(--fg-3);font-size:11px}.summary strong {color:var(--accent);font-size:12px}.track input {width:100%;height:6px;margin:0;appearance:none;border-radius:999px;background:linear-gradient(90deg,var(--accent) 0 var(--progress),var(--bg-3) var(--progress) 100%);cursor:pointer}.track input::-webkit-slider-thumb {width:18px;height:18px;appearance:none;border:3px solid var(--bg);border-radius:50%;background:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 55%,transparent)}.levels {display:flex;justify-content:space-between;margin-top:8px}.levels button {border:0;background:transparent;color:var(--fg-4);font:11px var(--sans);cursor:pointer}.levels button.active {color:var(--accent);font-weight:700}.effort-en {margin-left:5px;color:var(--fg-4);font-size:10px;font-weight:500;letter-spacing:.2px}.effort-level-en {display:block;margin-top:1px;color:var(--fg-4);font-size:8px;font-weight:500;line-height:1;opacity:.85}
</style>
