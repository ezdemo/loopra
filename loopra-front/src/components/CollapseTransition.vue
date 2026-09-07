<template>
  <Transition
    name="loopra-collapse"
    @before-enter="beforeEnter"
    @enter="enter"
    @after-enter="cleanup"
    @enter-cancelled="cleanup"
    @before-leave="beforeLeave"
    @leave="leave"
    @after-leave="cleanup"
    @leave-cancelled="cleanup"
  >
    <slot />
  </Transition>
</template>

<script setup>
const nextFrame = (callback) => {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(callback)
  } else {
    setTimeout(callback, 0)
  }
}

const getBorderHeight = (el) => {
  if (typeof window === 'undefined') return 0
  const style = window.getComputedStyle(el)
  return (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0)
}

const getExpandedHeight = (el) => Math.ceil(el.scrollHeight + getBorderHeight(el))

const beforeEnter = (el) => {
  el.style.height = '0px'
  el.style.opacity = '0'
  el.style.transform = 'translateY(-4px)'
  el.style.overflow = 'hidden'
  el.style.boxSizing = 'border-box'
  el.style.willChange = 'opacity, transform'
}

const enter = (el) => {
  // Force the collapsed layout to be committed before moving to the measured height.
  void el.offsetHeight
  nextFrame(() => {
    el.style.height = `${getExpandedHeight(el)}px`
    el.style.opacity = '1'
    el.style.transform = 'translateY(0)'
  })
}

const beforeLeave = (el) => {
  // Capture the rendered outer height, including padding and borders, so the
  // final frame does not leave a thin border/padding layer behind the header.
  el.style.height = `${Math.ceil(el.getBoundingClientRect().height)}px`
  el.style.opacity = '1'
  el.style.transform = 'translateY(0)'
  el.style.overflow = 'hidden'
  el.style.boxSizing = 'border-box'
  el.style.willChange = 'opacity, transform'
}

const leave = (el) => {
  // Force the current height to be committed so the browser can interpolate it.
  void el.offsetHeight
  nextFrame(() => {
    el.style.height = '0px'
    el.style.opacity = '0'
    el.style.transform = 'translateY(-4px)'
  })
}

const cleanup = (el) => {
  el.style.removeProperty('height')
  el.style.removeProperty('opacity')
  el.style.removeProperty('transform')
  el.style.removeProperty('overflow')
  el.style.removeProperty('box-sizing')
  el.style.removeProperty('will-change')
}
</script>

<style>
.loopra-collapse-enter-active,
.loopra-collapse-leave-active {
  overflow: hidden;
  box-sizing: border-box;
  transition:
    height 220ms cubic-bezier(0.22, 1, 0.36, 1),
    padding-block 180ms ease,
    border-top-width 180ms ease,
    border-bottom-width 180ms ease,
    opacity 160ms ease,
    transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

/* 收起时同步移除内容盒子的上下内边距和边框，避免标题下方残留一帧薄层。 */
.loopra-collapse-leave-to {
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  border-top-width: 0 !important;
  border-bottom-width: 0 !important;
}

@media (prefers-reduced-motion: reduce) {
  .loopra-collapse-enter-active,
  .loopra-collapse-leave-active {
    transition-duration: 1ms;
  }
}
</style>
