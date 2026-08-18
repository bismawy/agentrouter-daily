import { ClaimResult } from "./types";
import { isClaimedToday } from "./history";

export function renderDashboard(logs: ClaimResult[]): string {
  const latest = logs[0];
  const balanceDisplay = latest?.balance || "$0.00 USD";
  const userDisplay =
    (latest?.details?.displayName as string) ||
    (latest?.details?.githubId as string) ||
    (latest?.details?.username as string) ||
    "-";

  const hasClaimedToday = isClaimedToday(logs);

  const rows = logs
    .map((log) => {
      const dateObj = new Date(log.timestamp);
      const dateStr = dateObj.toLocaleDateString("id-ID", {
        timeZone: "Asia/Jakarta",
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      const statusTag = log.success
        ? `<span class="tag tag-success">BERHASIL</span>`
        : `<span class="tag tag-failed">GAGAL</span>`;

      return `
      <tr>
        <td class="col-date">${dateStr} WIB</td>
        <td class="col-status">${statusTag}</td>
        <td class="col-balance">${log.balance || "-"}</td>
        <td class="col-msg">${escapeHtml(log.message)}</td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentRouter Auto-Claim</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #09090b;
      --card-bg: #121215;
      --border: #27272a;
      --border-muted: #1f1f23;
      --text: #fafafa;
      --text-muted: #a1a1aa;
      --text-subtle: #71717a;
      --accent: #ffffff;
      --accent-muted: #27272a;
      --accent-hover: #3f3f46;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background-color: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 2.5rem 1rem;
      display: flex;
      justify-content: center;
      line-height: 1.5;
      letter-spacing: -0.02em;
    }
    .container {
      width: 100%;
      max-width: 860px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 2rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1.5rem;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .title {
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--text);
    }
    .subtitle {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }
    .btn {
      font-family: inherit;
      background: var(--text);
      color: var(--bg);
      border: 1px solid var(--text);
      padding: 0.5rem 1rem;
      font-size: 0.8rem;
      font-weight: 500;
      border-radius: 4px;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .btn:hover:not(:disabled) {
      opacity: 0.85;
    }
    .btn:disabled {
      background: var(--border-muted);
      color: var(--text-subtle);
      border-color: var(--border);
      cursor: not-allowed;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1px;
      background: var(--border);
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      margin-bottom: 2rem;
    }
    .stat-item {
      background: var(--card-bg);
      padding: 1.25rem;
    }
    .stat-label {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      margin-bottom: 0.5rem;
    }
    .stat-value {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text);
    }
    .stat-desc {
      font-size: 0.75rem;
      color: var(--text-subtle);
      margin-top: 0.25rem;
    }
    .section-title {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      margin-bottom: 0.75rem;
    }
    .table-box {
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow-x: auto;
      background: var(--card-bg);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.8rem;
    }
    th {
      background: #18181b;
      padding: 0.75rem 1rem;
      font-weight: 500;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      text-transform: uppercase;
      font-size: 0.75rem;
      white-space: nowrap;
    }
    td {
      padding: 0.85rem 1rem;
      border-bottom: 1px solid var(--border-muted);
    }
    tr:last-child td {
      border-bottom: none;
    }
    .col-date {
      white-space: nowrap;
      color: var(--text-muted);
    }
    .col-status {
      white-space: nowrap;
    }
    .col-balance {
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
    }
    .col-msg {
      color: var(--text-subtle);
      font-size: 0.75rem;
    }
    .tag {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      font-size: 0.7rem;
      font-weight: 600;
      border-radius: 3px;
    }
    .tag-success {
      background: #18181b;
      color: #fafafa;
      border: 1px solid #3f3f46;
    }
    .tag-failed {
      background: #18181b;
      color: #71717a;
      border: 1px solid #27272a;
    }
    .empty {
      text-align: center;
      padding: 2.5rem 1rem;
      color: var(--text-subtle);
      font-size: 0.8rem;
    }
    .footer {
      margin-top: 2rem;
      text-align: center;
      font-size: 0.75rem;
      color: var(--text-subtle);
      border-top: 1px solid var(--border-muted);
      padding-top: 1.5rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div>
        <h1 class="title">AgentRouter Auto-Claim</h1>
        <p class="subtitle">Jadwal: Harian 08:00 WIB (01:00 UTC)</p>
      </div>
      <div>
        <button id="claimBtn" class="btn" onclick="triggerClaim()" ${hasClaimedToday ? "disabled" : ""}>
          ${hasClaimedToday ? "Sudah Diklaim Hari Ini" : "Klaim Sekarang"}
        </button>
      </div>
    </header>

    <section class="stats-grid">
      <div class="stat-item">
        <div class="stat-label">Saldo Terkini</div>
        <div class="stat-value" id="valBalance">${balanceDisplay}</div>
        <div class="stat-desc">+ $25 / hari</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">Akun</div>
        <div class="stat-value" style="font-size: 1rem;">${escapeHtml(userDisplay)}</div>
        <div class="stat-desc">GitHub ID</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">Status Hari Ini</div>
        <div class="stat-value" style="font-size: 1rem;">
          ${hasClaimedToday ? "Terklaim" : "Belum Diklaim"}
        </div>
        <div class="stat-desc">${hasClaimedToday ? "Menunggu jadwal besok" : "Menunggu trigger"}</div>
      </div>
    </section>

    <h2 class="section-title">Riwayat Log</h2>
    <div class="table-box">
      <table>
        <thead>
          <tr>
            <th>Tanggal / Waktu</th>
            <th>Status</th>
            <th>Saldo</th>
            <th>Keterangan</th>
          </tr>
        </thead>
        <tbody id="tableBody">
          ${rows || '<tr><td colspan="4" class="empty">Belum ada riwayat tercatat.</td></tr>'}
        </tbody>
      </table>
    </div>

    <footer class="footer">
      Cloudflare Workers &bull; agentrouter.org Auto-Claim
    </footer>
  </div>

  <script>
    async function triggerClaim() {
      const btn = document.getElementById('claimBtn');
      btn.disabled = true;
      btn.innerText = "Memproses...";

      try {
        const res = await fetch('/trigger?notify=false', {
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();
        
        setTimeout(() => {
          window.location.reload();
        }, 500);
      } catch (err) {
        alert("Gagal: " + err.message);
        btn.disabled = false;
        btn.innerText = "Klaim Sekarang";
      }
    }
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
