import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core'
import { DomSanitizer } from '@angular/platform-browser'
import { inject } from '@angular/core'
import {
  Activity,
  Download,
  Workflow,
  GitCompareArrows,
  TableProperties,
  Funnel,
  FunnelX,
  ArrowDownLeft,
  ArrowUpRight,
  Merge,
  CornerDownRight,
  OctagonX,
  Pause,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Cable,
  Columns3,
  Dot,
  Eye,
  Folder,
  FolderOpen,
  Hash,
  History,
  KeyRound,
  Layers,
  Link,
  ListTree,
  RefreshCw,
  Search,
  SquareFunction,
  Table2,
  Tag,
  CircleAlert,
  Copy,
  Database,
  Lock,
  LockOpen,
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  Square,
  Sparkles,
  Trash2,
  X,
} from 'lucide'

type IconNode = [tag: string, attrs: Record<string, string | number | undefined>][]

/** Static map: only the icons we use end up in the bundle. */
const ICONS: Record<string, IconNode> = {
  activity: Activity,
  download: Download,
  diagram: Workflow,
  filter: Funnel,
  'filter-x': FunnelX,
  goto: ArrowUpRight,
  'goto-back': ArrowDownLeft,
  join: Merge,
  'tree-child': CornerDownRight,
  terminate: OctagonX,
  pause: Pause,
  alert: CircleAlert,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  'chevrons-up-down': ChevronsUpDown,
  column: Columns3,
  dot: Dot,
  enum: Tag,
  folder: Folder,
  'folder-open': FolderOpen,
  function: SquareFunction,
  history: History,
  index: ListTree,
  key: KeyRound,
  link: Link,
  matview: Layers,
  refresh: RefreshCw,
  search: Search,
  sequence: Hash,
  table: Table2,
  view: Eye,
  drawer: PanelRight,
  pin: Pin,
  'pin-off': PinOff,
  copy: Copy,
  database: Database,
  lock: Lock,
  unlock: LockOpen,
  sidebar: PanelLeft,
  edit: Pencil,
  play: Play,
  ai: Sparkles,
  compare: GitCompareArrows,
  'table-edit': TableProperties,
  plus: Plus,
  stop: Square,
  tunnel: Cable,
  trash: Trash2,
  x: X,
}

export type IconName = keyof typeof ICONS

/** An icon's inner SVG elements (from the static map, never user input). */
function iconBody(name: IconName): string {
  return (ICONS[name] ?? [])
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ')}/>`,
    )
    .join('')
}

/** A standalone, positioned icon for SVG documents built outside Angular (diagram export). */
export function iconSvg(name: IconName, x: number, y: number, size: number, color: string): string {
  return (
    `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${iconBody(name)}</svg>`
  )
}

@Component({
  selector: 'y-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0', 'aria-hidden': 'true' },
  template: `<svg
    xmlns="http://www.w3.org/2000/svg"
    [attr.width]="size()"
    [attr.height]="size()"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    [innerHTML]="body()"
  ></svg>`,
})
export class Icon {
  private readonly sanitizer = inject(DomSanitizer)

  readonly name = input.required<IconName>()
  readonly size = input(16)

  // Icon markup comes from the static map above, never from user input.
  protected readonly body = computed(() => this.sanitizer.bypassSecurityTrustHtml(iconBody(this.name())))
}
