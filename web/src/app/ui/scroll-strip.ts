import {
  afterRenderEffect,
  computed,
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  input,
  signal,
} from '@angular/core'

const FADE = 24

/**
 * A horizontal strip (the tab bar) that scrolls without a scrollbar: the mouse wheel scrolls it sideways,
 * the child marked `data-active` is kept in view, and the edges fade where more is hidden. `overflowing`
 * says whether everything fits (the tab bar then offers a list of all tabs).
 */
@Directive({
  selector: '[yScrollStrip]',
  exportAs: 'scrollStrip',
  host: {
    class: 'scroll-strip',
    '[style.mask-image]': 'mask()',
    '(wheel)': 'onWheel($event)',
    // A scrollable strip would start the browser's middle-button autoscroll and swallow the
    // middle click (closing a tab); the wheel scrolls it instead.
    '(mousedown)': 'onMouseDown($event)',
    '(scroll)': 'measure()',
  },
})
export class ScrollStrip {
  /** Whatever identifies the active child; when it changes, that child is scrolled into view. */
  readonly yScrollStrip = input<unknown>()

  readonly overflowing = signal(false)
  private readonly hiddenStart = signal(false)
  private readonly hiddenEnd = signal(false)
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement

  protected readonly mask = computed(() => {
    const start = this.hiddenStart() ? 'transparent' : '#000'
    const end = this.hiddenEnd() ? 'transparent' : '#000'
    return start === end && start === '#000'
      ? null
      : `linear-gradient(to right, ${start}, #000 ${FADE}px, #000 calc(100% - ${FADE}px), ${end})`
  })

  constructor() {
    // The box resizing (window, sidebar, or the "all tabs" button appearing beside it) keeps the active
    // child in view; the content changing (tabs opened, closed, renamed) only re-measures.
    const resize = new ResizeObserver(() => this.reveal())
    resize.observe(this.el)
    const content = new MutationObserver(() => this.measure())
    content.observe(this.el, { childList: true, subtree: true, characterData: true })
    inject(DestroyRef).onDestroy(() => {
      resize.disconnect()
      content.disconnect()
    })

    afterRenderEffect(() => {
      this.yScrollStrip()
      this.reveal()
    })
  }

  private reveal() {
    this.el
      .querySelector<HTMLElement>('[data-active]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    this.measure()
  }

  protected measure() {
    const { scrollLeft, scrollWidth, clientWidth } = this.el
    this.overflowing.set(scrollWidth > clientWidth + 1)
    this.hiddenStart.set(scrollLeft > 1)
    this.hiddenEnd.set(scrollLeft + clientWidth < scrollWidth - 1)
  }

  /** Not a `&&` expression in the binding: a listener returning false makes Angular cancel every press. */
  protected onMouseDown(e: MouseEvent) {
    if (e.button === 1) e.preventDefault()
  }

  /** A vertical wheel scrolls the strip sideways (a touchpad's sideways swipe already does). */
  protected onWheel(e: WheelEvent) {
    if (!this.overflowing() || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    e.preventDefault()
    this.el.scrollLeft += e.deltaY
  }
}
