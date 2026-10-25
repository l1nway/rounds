import {useEffectEvent, useLayoutEffect} from 'react'

const MOBILE = ['ios', 'android']

export const tg = () => window.Telegram?.WebApp
export const inTelegram = () => Boolean(tg()?.initData)
const since = version => inTelegram() && tg().isVersionAtLeast(version)

export const haptic = {
  tick: () => since('6.1') && tg().HapticFeedback.selectionChanged(),
  tap: (style = 'light') => since('6.1') && tg().HapticFeedback.impactOccurred(style),
  notify: type => since('6.1') && tg().HapticFeedback.notificationOccurred(type)
}

export const close = () => tg()?.close()

// [DOC: telegram-setup]
export const setupTelegram = () => {
  if (!inTelegram()) return
  const app = tg()
  app.ready()
  app.expand()
  if (since('6.1')) {app.setHeaderColor('bg_color'); app.setBackgroundColor('bg_color')}
  if (since('7.10')) app.setBottomBarColor('bottom_bar_bg_color')
  if (since('7.7')) app.disableVerticalSwipes()
  if (since('8.0') && MOBILE.includes(app.platform)) app.requestFullscreen()
}

// [DOC: main-button]
export const useMainButton = ({text, visible, active, progress, onClick}) => {
  const click = useEffectEvent(onClick)
  useLayoutEffect(() => {
    const button = tg()?.MainButton
    if (!button) return
    const handler = () => click()
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
