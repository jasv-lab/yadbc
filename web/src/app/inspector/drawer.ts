import { ChangeDetectionStrategy, Component, inject } from '@angular/core'
import { Commands } from '../core/commands'
import { Icon } from '../ui/icon'
import { CellInspector } from './cell-inspector'
import { InspectorPanel } from './inspector-panel'
import { EditsPanel } from '../editing/edits-panel'
import { SearchPanel } from '../search/search-panel'
import { AiPanel } from '../ai/ai-panel'
import { ValueSearch } from '../search/value-search'

const MIN_WIDTH = 280

/**
 * Right-hand drawer. Overlay by default (the grid keeps its width for quick looks); pinned it pushes
 * the layout for side-by-side work. One view at a time — Cell now, Explain and Edits later.
 */
@Component({
  selector: 'y-drawer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, InspectorPanel, EditsPanel, SearchPanel, AiPanel],
  host: {
    class: 'relative flex flex-col border-l border-line bg-raised',
    '[class.drawer-overlay]': '!inspector.pinned()',
    '[style.width.px]': 'inspector.width()',
  },
  template: `
    <div class="grip" (pointerdown)="startResize($event)" title="Drag to resize"></div>
    <div class="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-sunken px-2">
      <div class="flex rounded border border-line p-0.5 text-[12px]">
        <button
          class="rounded-[3px] px-2"
          [class]="inspector.view() === 'cell' ? 'bg-selected text-fg' : 'text-muted'"
          (click)="inspector.view.set('cell')"
        >
          Cell
        </button>
        <button
          class="rounded-[3px] px-2"
          [class]="inspector.view() === 'ai' ? 'bg-selected text-fg' : 'text-muted'"
          (click)="inspector.view.set('ai')"
        >
          AI
        </button>
        @if (search.state()) {
          <button
            class="rounded-[3px] px-2"
            [class]="inspector.view() === 'search' ? 'bg-selected text-fg' : 'text-muted'"
            (click)="inspector.view.set('search')"
          >
            Find
          </button>
        }
        @if (inspector.editsTarget()) {
          <button
            class="rounded-[3px] px-2"
            [class]="inspector.view() === 'edits' ? 'bg-selected text-fg' : 'text-muted'"
            (click)="inspector.view.set('edits')"
          >
            Edits
          </button>
        }
      </div>
      <span class="flex-1"></span>
      <button
        class="icon-btn"
        [title]="inspector.pinned() ? 'Unpin (overlay)' : 'Pin (make room)'"
        (click)="inspector.setPinned(!inspector.pinned())"
      >
        <y-icon [name]="inspector.pinned() ? 'pin-off' : 'pin'" [size]="14" />
      </button>
      <button class="icon-btn" [title]="commands.tooltip('view.drawer')" (click)="inspector.close()">
        <y-icon name="x" [size]="14" />
      </button>
    </div>
    @if (inspector.view() === 'edits' && inspector.editsTarget(); as t) {
      <y-edits-panel [tab]="t.tab" [result]="t.result" />
    } @else if (inspector.view() === 'search') {
      <y-search-panel />
    } @else if (inspector.view() === 'ai') {
      <y-ai-panel />
    } @else {
      <y-inspector-panel />
    }
  `,
  styles: `
    :host(.drawer-overlay) {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 20;
      box-shadow: -8px 0 24px rgb(0 0 0 / 0.18);
    }
    .grip {
      position: absolute;
      left: -3px;
      top: 0;
      bottom: 0;
      width: 6px;
      cursor: col-resize;
      z-index: 1;
    }
  `,
})
export class Drawer {
  protected readonly inspector = inject(CellInspector)
  protected readonly commands = inject(Commands)
  protected readonly search = inject(ValueSearch)

  protected startResize(e: PointerEvent) {
    e.preventDefault()
    const grip = e.target as HTMLElement
    grip.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startW = this.inspector.width()
    const max = () => window.innerWidth * 0.7
    let frame = 0
    let latest = startW
    const move = (ev: PointerEvent) => {
      latest = Math.min(max(), Math.max(MIN_WIDTH, startW + startX - ev.clientX))
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => this.inspector.width.set(latest))
    }
    const up = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      // The last frame may not have run yet: save the final value, not the last painted one.
      cancelAnimationFrame(frame)
      this.inspector.setWidth(latest)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
  }
}
