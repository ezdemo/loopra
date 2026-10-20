<template>
  <form class="acp-elicitation-form" role="dialog" aria-label="Agent 提问" @submit.prevent="last ? submit('accept') : navigate(index + 1)">
    <header aria-live="polite">{{ pages.length > 1 ? `问题 ${index + 1} / ${pages.length}` : 'Agent 提问' }}</header>
    <div ref="body" class="acp-elicitation-body" role="region" aria-label="当前问题内容" tabindex="0">
    <p>{{ request.message || '请回答以下问题' }}</p>
    <fieldset v-for="[name, field] in pages[index]?.fields || []" :key="name" :disabled="busy">
      <legend>{{ field.title || name }}{{ request.schema.required?.includes(name) ? ' *' : '' }}</legend>
      <p v-if="field.description">{{ field.description }}</p>
      <select v-if="field.type === 'boolean' || options(field).length" :aria-label="field.title || name"
              :multiple="field.type === 'array'" :value="selectedIndex(field, answers[name])" @change="pick(name, field, $event)">
        <option v-if="field.type !== 'array'" value="">请选择</option>
        <option v-for="(option, index) in options(field)" :key="index" :value="String(index)">{{ option.title || String(option.const) }}{{ option.description ? ' — ' + option.description : '' }}</option>
      </select>
      <input v-else-if="field.type === 'number' || field.type === 'integer'" type="number" :aria-label="field.title || name"
             :min="field.minimum" :max="field.maximum" :step="field.type === 'integer' ? 1 : 'any'" :value="answers[name] ?? ''" @input="answers[name] = $event.target.value === '' ? undefined : $event.target.valueAsNumber" />
      <input v-else-if="field._meta?.codex?.isSecret" type="password" autocomplete="off" :aria-label="field.title || name" v-model="answers[name]" />
      <textarea v-else :aria-label="field.title || name" :value="Array.isArray(answers[name]) ? answers[name].join('\n') : answers[name] || ''"
                :maxlength="field.maxLength" @input="answers[name] = field.type === 'array' ? $event.target.value.split('\n').filter(Boolean) : $event.target.value" />
    </fieldset>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <footer><button type="button" class="acp-skip" :disabled="busy" @click="submit('decline')">跳过</button>
      <button v-if="pages.length > 1" type="button" :disabled="busy || index === 0" @click="navigate(index - 1)">← 上一题</button>
      <button v-if="!last" type="button" @click.prevent="navigate(index + 1)">下一题 →</button>
      <button v-else type="submit" :disabled="busy">{{ busy ? '提交中…' : '提交' }}</button></footer>
  </form>
</template>

<script setup>
import {computed, nextTick, ref, watch} from 'vue'
import {elicitationContent, elicitationError, elicitationOptions, elicitationPages, elicitationPageError} from '../../web/src/elicitation'
const props = defineProps({request: {type: Object, required: true}, answer: {type: Function, required: true}})
const answers = ref({}), busy = ref(false), error = ref('')
const index = ref(0), body = ref(null)
const pages = computed(() => elicitationPages(props.request))
const last = computed(() => index.value >= pages.value.length - 1)
watch(index, () => nextTick(() => { if (body.value) body.value.scrollTop = 0 }))
function navigate(next) { index.value = next; error.value = '' }
const options = field => field.type === 'boolean' ? [{const: true, title: '是'}, {const: false, title: '否'}] : elicitationOptions(field.type === 'array' ? field.items || {} : field)
const selectedIndex = (field, value) => field.type === 'array' ? options(field).flatMap((option, index) => Array.isArray(value) && value.includes(option.const) ? [String(index)] : []) : value === undefined ? '' : String(options(field).findIndex(option => option.const === value))
function pick(name, field, event) {
  answers.value[name] = field.type === 'array' ? [...event.target.selectedOptions].map(option => options(field)[Number(option.value)].const)
    : event.target.value === '' ? undefined : options(field)[Number(event.target.value)].const
}
async function submit(action) {
  error.value = action === 'accept' ? elicitationError(props.request, answers.value) : ''
  if (error.value) {
    const invalid = pages.value.findIndex(page => elicitationPageError(props.request, page, answers.value))
    if (invalid >= 0) index.value = invalid
    return
  }
  busy.value = true
  try { await props.answer(props.request, action, action === 'accept' ? elicitationContent(props.request, answers.value) : {}) }
  catch (cause) { error.value = cause.message || String(cause); busy.value = false }
}
</script>

<style scoped>
.acp-elicitation-form { display: flex; flex-direction: column; min-height: 0; margin: 8px 20px; padding: 16px; border: 1px solid var(--border-color, #ddd); border-radius: 12px; background: var(--bg-primary, white); max-height: min(50dvh, 28rem); overflow: hidden; }
header, footer, [role=alert] { flex-shrink: 0; }
header { font-size: 12px; margin-bottom: 8px; }
.acp-elicitation-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-right: 4px; }
fieldset { border: 0; margin: 14px 0; padding: 0; }
legend { font-weight: 600; margin-bottom: 6px; }
p { margin: 4px 0; }
input, select, textarea { width: 100%; padding: 8px; color: inherit; background: transparent; border: 1px solid var(--border-color, #ddd); border-radius: 6px; }
footer { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 10px; }
.acp-skip { margin-right: auto; }
button { padding: 6px 16px; cursor: pointer; }
</style>
