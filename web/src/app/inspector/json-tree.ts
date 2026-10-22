import { ChangeDetectionStrategy, Component, computed, input, linkedSignal } from '@angular/core'
import { Icon } from '../ui/icon'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Collapsible JSON tree; the first levels start expanded. */
@Component({
  selector: 'y-json-tree',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, JsonTree],
  template: `
    @if (isContainer()) {
      <div class="flex items-center gap-1">
        <button class="flex items-center gap-1 rounded hover:bg-hover" (click)="expanded.set(!expanded())">
          <y-icon [name]="expanded() ? 'chevron-down' : 'chevron-right'" [size]="12" class="text-faint" />
          @if (key() !== undefined) {
            <span class="k">{{ key() }}</span
            ><span class="text-faint">:</span>
          }
          <span class="text-faint">{{ isArray() ? '[' : '{' }}</span>
          @if (!expanded()) {
            <span class="text-faint">{{ summary() }} {{ isArray() ? ']' : '}' }}</span>
          }
        </button>
      </div>
      @if (expanded()) {
        <div class="ml-[7px] border-l border-line pl-3">
          @for (entry of entries(); track entry[0]) {
            <y-json-tree [key]="entry[0]" [value]="entry[1]" [depth]="depth() + 1" />
          }
        </div>
        <div class="pl-4 text-faint">{{ isArray() ? ']' : '}' }}</div>
      }
    } @else {
      <div class="pl-4 break-all whitespace-pre-wrap">
        @if (key() !== undefined) {
          <span class="k">{{ key() }}</span
          ><span class="text-faint">: </span>
        }
        <span [class]="scalarClass()">{{ scalarText() }}</span>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      font: 12.5px/20px var(--font-mono);
    }
    .k {
      color: var(--fg-muted);
    }
    .s {
      color: light-dark(#0f6e56, #5dcaa5);
    }
    .n {
      color: light-dark(#993c1d, #f0997b);
    }
    .b {
      color: light-dark(#534ab7, #a5a0f5);
    }
  `,
})
export class JsonTree {
  readonly value = input.required<Json>()
  readonly key = input<string | undefined>(undefined)
  readonly depth = input(0)

  protected readonly isArray = computed(() => Array.isArray(this.value()))
  protected readonly isContainer = computed(() => {
    const v = this.value()
    return v !== null && typeof v === 'object'
  })
  protected readonly entries = computed((): [string, Json][] => {
    const v = this.value()
    if (Array.isArray(v)) return v.map((item, i) => [String(i), item])
    return v !== null && typeof v === 'object' ? Object.entries(v) : []
  })
  protected readonly summary = computed(() => {
    const n = this.entries().length
    return this.isArray() ? `${n} ${n === 1 ? 'item' : 'items'}` : `${n} ${n === 1 ? 'key' : 'keys'}`
  })
  protected readonly scalarText = computed(() => {
    const v = this.value()
    return typeof v === 'string' ? JSON.stringify(v) : String(v)
  })
  protected readonly scalarClass = computed(() => {
    const v = this.value()
    return typeof v === 'string' ? 's' : typeof v === 'number' ? 'n' : 'b'
  })

  /** Deep or huge levels start collapsed so a big document opens instantly; the user can toggle. */
  protected readonly expanded = linkedSignal(() => this.depth() < 2 && this.entries().length <= 200)
}
