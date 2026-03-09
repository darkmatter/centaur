// Cell formatting
export type CellFormat = "currency" | "percent" | "number" | "date" | "text" | "compact-currency";

// --- Rich cell renderers for data-table columns ---
export type BadgeCellDef = {
  type: "badge";
  intentMap?: Record<string, "default" | "success" | "warning" | "destructive" | "outline">;
};

export type PillCellDef = {
  type: "pill";
  colorMap?: Record<string, string>; // value → tailwind color token
};

export type AvatarCellDef = {
  type: "avatar";
  nameKey?: string; // fallback initials from another column
};

export type StackedTextCellDef = {
  type: "stacked-text";
  secondaryKey: string; // key for the smaller secondary line
  secondaryFormat?: CellFormat;
};

export type LinkCellDef = {
  type: "link";
  hrefKey: string; // key for the URL
};

export type CellRenderer = BadgeCellDef | PillCellDef | AvatarCellDef | StackedTextCellDef | LinkCellDef;

// --- Column definition ---
export interface ColumnDef {
  key: string;
  label: string;
  format: CellFormat;
  sortable?: boolean;
  filterable?: boolean; // show filter pills for this column's unique values
  cell?: CellRenderer;
  minWidth?: number; // px — prevents truncation
  align?: "left" | "right" | "center";
  hidden?: boolean;
}

// --- Component nodes (composable tree) ---

// Layout primitives
export interface StackNode {
  type: "stack";
  gap?: number;
  direction?: "vertical" | "horizontal";
  children: ComponentNode[];
}

export interface GridNode {
  type: "grid";
  columns: number; // 1-4
  gap?: number;
  children: ComponentNode[];
}

export interface CardNode {
  type: "card";
  title?: string;
  children: ComponentNode[];
}

export interface TabItem {
  key: string;
  label: string;
  count?: number;
  content: ComponentNode;
}

export interface TabsNode {
  type: "tabs";
  defaultTab?: string;
  tabs: TabItem[];
}

export interface SplitNode {
  type: "split";
  ratio?: string; // e.g. "1:2", "1:3" — default "1:2"
  children: [ComponentNode, ComponentNode];
}

export interface ToolbarNode {
  type: "toolbar";
  children: ComponentNode[];
}

// Display primitives
export interface TextNode {
  type: "text";
  content: string;
  variant?: "heading" | "subheading" | "body" | "caption" | "code";
}

export interface BadgeNode {
  type: "badge";
  text: string;
  intent?: "default" | "success" | "warning" | "destructive" | "outline";
}

export interface PillNode {
  type: "pill";
  text: string;
  color?: string;
}

export interface AvatarNode {
  type: "avatar";
  name: string;
  src?: string;
  size?: "sm" | "md" | "lg";
}

export interface StatusDotNode {
  type: "status-dot";
  status: "success" | "warning" | "error" | "idle" | "running";
  label?: string;
}

export interface IconNode {
  type: "icon";
  name: string;
  size?: number;
}

// Data components
export interface DataTableNode {
  type: "data-table";
  title?: string;
  columns: ColumnDef[];
  data: readonly Record<string, unknown>[];
  defaultSort?: { key: string; direction: "asc" | "desc" };
  searchable?: boolean;
  pageSize?: number; // default 25
  virtualizeThreshold?: number; // rows above this count use virtualization, default 100
  compact?: boolean; // denser row height
  striped?: boolean; // alternating row colors, default true
  stickyHeader?: boolean; // default true
  dataSource?: DataSource;
}

export interface KPICardNode {
  type: "kpi-card";
  label: string;
  value: number;
  format: CellFormat;
  delta?: number;
  sparkline?: number[]; // optional inline sparkline
  dataSource?: DataSource;
}

export interface LineChartNode {
  type: "line-chart";
  title: string;
  xKey: string;
  yKeys: string[];
  data: readonly Record<string, unknown>[];
  xFormat?: CellFormat;
  yFormat?: CellFormat;
  height?: number;
  dataSource?: DataSource;
}

export interface BarChartNode {
  type: "bar-chart";
  title: string;
  categoryKey: string;
  valueKey: string;
  data: readonly Record<string, unknown>[];
  height?: number;
  horizontal?: boolean;
  dataSource?: DataSource;
}

export interface PieChartNode {
  type: "pie-chart";
  title: string;
  labelKey: string;
  valueKey: string;
  data: readonly Record<string, unknown>[];
  height?: number;
  dataSource?: DataSource;
}

// New domain components
export interface DetailKVItem {
  label: string;
  value: string | ComponentNode;
  format?: CellFormat;
}

export interface DetailKVNode {
  type: "detail-kv";
  title?: string;
  columns?: number; // layout in N columns, default 2
  items: DetailKVItem[];
}

export interface TimelineEntry {
  date: string;
  title: string;
  description?: string;
  badge?: { text: string; intent?: BadgeNode["intent"] };
}

export interface TimelineNode {
  type: "timeline";
  title?: string;
  entries: TimelineEntry[];
}

export interface PeopleListPerson {
  name: string;
  title?: string;
  company?: string;
  avatar?: string;
  tags?: string[];
}

export interface PeopleListNode {
  type: "people-list";
  title?: string;
  people: PeopleListPerson[];
  searchable?: boolean;
  pageSize?: number;
}

export interface EmptyStateNode {
  type: "empty-state";
  title: string;
  description?: string;
  icon?: string;
}

// --- Union of all nodes ---
export type ComponentNode =
  // Layout
  | StackNode
  | GridNode
  | CardNode
  | TabsNode
  | SplitNode
  | ToolbarNode
  // Display
  | TextNode
  | BadgeNode
  | PillNode
  | AvatarNode
  | StatusDotNode
  | IconNode
  // Data
  | DataTableNode
  | KPICardNode
  | LineChartNode
  | BarChartNode
  | PieChartNode
  // Domain
  | DetailKVNode
  | TimelineNode
  | PeopleListNode
  | EmptyStateNode;

// --- Top-level spec ---
export interface DashboardSpec {
  title: string;
  layout: "single" | "grid-2" | "grid-3";
  components: ComponentNode[];
}

// --- Data source types (live polling) ---
export interface InlineDataSource {
  type: "inline";
}

export interface SqlDataSource {
  type: "sql";
  query: string;
  refreshInterval?: number; // seconds between polls (0 or absent = static)
  target?: "internal" | "allium" | "bigquery";
}

export interface ApiDataSource {
  type: "api";
  endpoint: string;
  params?: Record<string, string>;
  refreshInterval?: number;
}

export type DataSource = InlineDataSource | SqlDataSource | ApiDataSource;

// --- Data source mixin for data components ---
export interface DataSourceMixin {
  dataSource?: DataSource;
}

// --- Backward compatibility aliases ---
export type DataTableProps = DataTableNode;
export type KPICardProps = KPICardNode;
export type LineChartProps = LineChartNode;
export type BarChartProps = BarChartNode;
export type PieChartProps = PieChartNode;
export type DashboardComponent = ComponentNode;
