/**
 * Mock back-office tools for the NOA agent. Each simulates an API call against a
 * single demo client and returns plain JS objects. Claude reasons over these and
 * produces a SPOKEN summary (-> Sonic); the raw object is also emitted as a UI card.
 *
 * Swap the bodies for real HTTP calls later — the tool *contract* (name + schema +
 * return shape) is what the agent depends on, not the data source.
 */

// ── demo client record (one customer; coherent across all tools) ──
const CLIENT = {
  id: "CL-4471",
  name: "Eleanor Whitfield",
  plan: "Premium Home Care",
  status: "active",
  phone: "+1 (415) 555-0147",
  address: "82 Larkspur Lane, Oakland, CA",
  joined: "2023-02-14",
};

const INVOICES = [
  { id: "INV-1001", amount: 89.0, issued: "2026-06-01", due: "2026-06-30", status: "open" },
  { id: "INV-0990", amount: 89.0, issued: "2026-05-01", due: "2026-05-30", status: "paid" },
  { id: "INV-0975", amount: 120.0, issued: "2026-05-01", due: "2026-05-15", status: "overdue" },
];

const VISITS = [
  {
    id: "VIS-22",
    date: "2026-06-25",
    status: "scheduled",
    technician: "Marcus Allen",
    reason: "Medical alert device annual check",
  },
  {
    id: "VIS-19",
    date: "2026-06-01",
    status: "completed",
    technician: "Priya Nair",
    reason: "Home safety inspection",
  },
];

const DELIVERIES = [
  {
    id: "ORD-330",
    item: "Blood pressure monitor",
    status: "in_transit",
    carrier: "FedEx",
    eta: "2026-06-24",
    tracking: "FX7741209934",
  },
  {
    id: "ORD-318",
    item: "Automatic medication dispenser",
    status: "delivered",
    carrier: "UPS",
    delivered: "2026-06-10",
    tracking: "1Z998AA10123456784",
  },
];

const PAYMENTS = [
  { id: "PAY-77", amount: 89.0, date: "2026-05-28", method: "Visa •4821", status: "succeeded" },
  { id: "PAY-71", amount: 89.0, date: "2026-04-27", method: "Visa •4821", status: "succeeded" },
  { id: "PAY-66", amount: 120.0, date: "2026-05-16", method: "Visa •4821", status: "declined" },
];

// ── Anthropic tool definitions (sent to the model) ──
export const toolDefs = [
  {
    name: "check_client",
    description: "Look up the client's profile: name, plan, account status, contact info.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "check_invoices",
    description: "List the client's invoices. Optionally filter by status.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["open", "paid", "overdue", "all"] },
      },
    },
  },
  {
    name: "check_visits",
    description: "List the client's technical/home visits (scheduled and completed).",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "check_delivery_status",
    description: "Check status of the client's equipment deliveries/orders.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "check_payments",
    description: "List the client's recent payment transactions.",
    input_schema: { type: "object" as const, properties: {} },
  },
];

// ── executors: name -> (input) -> result object ──
export type ToolResult = { card: { type: string; [k: string]: unknown }; data: unknown };

export function runTool(name: string, input: Record<string, unknown>): ToolResult {
  switch (name) {
    case "check_client":
      return { card: { type: "client", ...CLIENT }, data: CLIENT };

    case "check_invoices": {
      const status = (input.status as string) ?? "all";
      const rows = status === "all" ? INVOICES : INVOICES.filter((i) => i.status === status);
      return { card: { type: "invoices", filter: status, invoices: rows }, data: rows };
    }

    case "check_visits":
      return { card: { type: "visits", visits: VISITS }, data: VISITS };

    case "check_delivery_status":
      return { card: { type: "deliveries", deliveries: DELIVERIES }, data: DELIVERIES };

    case "check_payments":
      return { card: { type: "payments", payments: PAYMENTS }, data: PAYMENTS };

    default:
      return { card: { type: "error", name }, data: { error: `unknown tool: ${name}` } };
  }
}
