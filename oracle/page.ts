type Sample = { price: string; time: number };
type Status = {
  assetId: string | null;
  issueTxid: string | null;
  deployTxid: string | null;
  wallet: string | null;
  balance: string | null;
  address: string | null;
  args: { ctrlTxid: string | null; domain: string; keyLag: number; readFee: number; adminPk: string | null; exit: number };
  fixings: unknown[];
  samples: number;
  latest: Sample | null;
};

const byId = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;

function lines(parent: HTMLElement, tag: string, texts: string[]): void {
  parent.replaceChildren(...texts.map((text) => {
    const el = document.createElement(tag);
    el.className = "mono";
    el.textContent = text;
    return el;
  }));
}

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${byId("token").value}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
}

async function refresh(): Promise<void> {
  const body = (await (await fetch("/api/status")).json()) as Status;
  const { args } = body;
  const latest = body.latest ? `${body.latest.price} cents at ${body.latest.time}` : "none";
  lines(byId("status"), "p", [
    `Key lag ${args.keyLag}. Read fee ${args.readFee}. Exit ${args.exit}.`,
    `Domain ${args.domain}`,
    `Admin ${args.adminPk ?? "unset"}`,
    `Fund ${body.wallet ?? "unset"}`,
    `Balance ${body.balance ?? "unset"} sats`,
    `Asset ${body.assetId ?? "unset"}`,
    `Deploy ${body.deployTxid ?? "unset"}`,
    `Beacon ${body.address ?? "unset"}`,
    `BEACON_TXID ${body.issueTxid ?? "unset"}`,
    `ctrlTxid ${args.ctrlTxid ?? "unset"}`,
    `Fixings ${body.fixings.length}. Samples ${body.samples}. Latest ${latest}.`,
  ]);
}

function shown(errorId: string, work: () => Promise<void>): void {
  byId(errorId).textContent = "";
  work().then(refresh).catch((err: Error) => {
    byId(errorId).textContent = err.message;
  });
}

byId("issue").addEventListener("click", () => shown("admin-error", () => post("/api/issue", {})));
byId("recover").addEventListener("click", () => shown("admin-error", () => post("/api/recover", {})));
byId("deploy").addEventListener("click", () => shown("admin-error", () => post("/api/deploy", {})));
byId("sample").addEventListener("submit", (event) => {
  event.preventDefault();
  shown("sample-error", () => post("/api/samples", { price: byId("price").value }));
});

void refresh().catch((err: Error) => {
  byId("admin-error").textContent = err.message;
});
