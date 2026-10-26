import {useLayoutEffect, useRef} from 'react'

const MOBILE = ['ios', 'android']
const SETTLE = 1000

export const tg = () => window.Telegram?.WebApp
export const inTelegram = () => Boolean(tg()?.initData)
const since = version => inTelegram() && tg().isVersionAtLeast(version)

export const haptic = {
  tick: () => since('6.1') && tg().HapticFeedback.selectionChanged(),
  tap: (style = 'light') => since('6.1') && tg().HapticFeedback.impactOccurred(style),
  notify: type => since('6.1') && tg().HapticFeedback.notificationOccurred(type)
}

export const close = () => tg()?.close()

const enter = () => {document.documentElement.dataset.enter = ''}

// [DOC: entrance]
const settle = (app, fullscreen) => {
  const final = () => app.isExpanded && (!fullscreen || app.isFullscreen)
  if (final()) return enter()
  const events = {viewportChanged: ({isStateStable}) => isStateStable && final() && done(), fullscreenChanged: () => final() && done(), fullscreenFailed: () => done()}
  const each = method => Object.entries(events).forEach(([name, handler]) => app[method](name, handler))
  const done = () => {clearTimeout(timer); each('offEvent'); enter()}
  const timer = setTimeout(done, SETTLE)
  each('onEvent')
}

// [DOC: telegram-setup]
export const setupTelegram = () => {
  if (!inTelegram()) return enter()
  const app = tg()
  const fullscreen = since('8.0') && MOBILE.includes(app.platform)
  app.ready()
  app.expand()
  if (since('6.1')) {app.setHeaderColor('bg_color'); app.setBackgroundColor('bg_color')}
  if (since('7.10')) app.setBottomBarColor('bottom_bar_bg_color')
  if (since('7.7')) app.disableVerticalSwipes()
  if (fullscreen) app.requestFullscreen()
  settle(app, fullscreen)
}

// [DOC: main-button]
export const useMainButton = ({text, visible, active, progress, onClick}) => {
  const click = useRef(onClick)
  useLayoutEffect(() => {click.current = onClick})
  useLayoutEffect(() => {
    const button = tg()?.MainButton
    if (!button) return
    const handler = () => click.current()
    button.onClick(handler)
    return () => {button.offClick(handler); button.hideProgress().hide()}
  }, [])
  useLayoutEffect(() => {
    const button = tg()?.MainButton
    if (!button) return
    button.setParams({text, is_visible: visible, is_active: active && !progress})
    if (progress) button.showProgress(false)
    else button.hideProgress()
  }, [text, visible, active, progress])
}
