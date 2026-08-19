import { ClaimResult } from "./types";
import { isClaimedToday } from "./history";

export function renderDashboard(
  logs: ClaimResult[],
  liveUser?: {
    balance?: string;
    displayName?: string;
    githubId?: string;
    username?: string;
    lastLoginTime?: number;
  }
): string {
  const latest = logs[0];
  const balanceDisplay = latest?.balance || liveUser?.balance || "$0.00 USD";
  const userDisplay =
    (latest?.details?.displayName as string) ||
    (latest?.details?.githubId as string) ||
    (latest?.details?.username as string) ||
    liveUser?.displayName ||
    liveUser?.githubId ||
    liveUser?.username ||
    "-";

  const hasClaimedToday = isClaimedToday(logs, liveUser?.lastLoginTime);
  const logsJson = JSON.stringify(logs).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>AgentRouter Auto-Claim</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #09090b;
      --card-bg: #121215;
      --card-hover: #18181b;
      --border: #27272a;
      --border-muted: #1f1f23;
      --text: #fafafa;
      --text-muted: #a1a1aa;
      --text-subtle: #71717a;
      --accent: #ffffff;
      --accent-muted: #27272a;
      --accent-hover: #3f3f46;
      --success-bg: #052e16;
      --success-border: #14532d;
      --success-text: #4ade80;
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
      padding: 2rem 1rem;
      display: flex;
      justify-content: center;
      line-height: 1.5;
      letter-spacing: -0.02em;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      width: 100%;
      max-width: 860px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.75rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1.25rem;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .title {
      font-size: 1.15rem;
      font-weight: 600;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .subtitle {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }
    .btn {
      font-family: inherit;
      background: var(--text);
      color: var(--bg);
      border: 1px solid var(--text);
      padding: 0.55rem 1.15rem;
      font-size: 0.8rem;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
    }
    .btn:hover:not(:disabled) {
      background: #e4e4e7;
      border-color: #e4e4e7;
    }
    .btn:disabled {
      background: #18181b;
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
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 2rem;
    }
    .stat-item {
      background: var(--card-bg);
      padding: 1.25rem;
    }
    .stat-label {
      font-size: 0.72rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.4rem;
    }
    .stat-value {
      font-size: 1.3rem;
      font-weight: 700;
      color: var(--text);
      line-height: 1.2;
    }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
    }
    .section-title {
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .table-box {
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      background: var(--card-bg);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.8rem;
    }
    th {
      background: #151518;
      padding: 0.75rem 1rem;
      font-weight: 600;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      text-transform: uppercase;
      font-size: 0.7rem;
      letter-spacing: 0.04em;
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
      font-size: 0.78rem;
    }
    .col-status {
      white-space: nowrap;
    }
    .col-balance {
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
    }
    .col-reward {
      font-weight: 600;
      white-space: nowrap;
    }
    .reward-ok {
      color: var(--success-text);
    }
    .reward-none {
      color: var(--text-subtle);
      font-weight: 400;
    }
    .tag {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      font-size: 0.68rem;
      font-weight: 600;
      border-radius: 4px;
      letter-spacing: 0.02em;
    }
    .tag-success {
      background: var(--success-bg);
      color: var(--success-text);
      border: 1px solid var(--success-border);
    }
    .tag-failed {
      background: #27272a;
      color: #a1a1aa;
      border: 1px solid #3f3f46;
    }
    .empty {
      text-align: center;
      padding: 3rem 1rem;
      color: var(--text-subtle);
      font-size: 0.8rem;
    }
    .pagination {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      margin-top: 1rem;
    }
    .pagination .btn {
      padding: 0.3rem 0.7rem;
      font-size: 0.85rem;
      min-width: 2.2rem;
    }
    .page-info {
      font-size: 0.78rem;
      color: var(--text-muted);
      min-width: 3rem;
      text-align: center;
    }
    .footer {
      margin-top: 2rem;
      text-align: center;
      font-size: 0.72rem;
      color: var(--text-subtle);
      border-top: 1px solid var(--border-muted);
      padding-top: 1.5rem;
    }

    /* RESPONSIVE MOBILE LAYOUT (<640px) */
    @media (max-width: 640px) {
      body {
        padding: 1.25rem 0.75rem;
      }
      .header {
        flex-direction: column;
        align-items: stretch;
        gap: 0.85rem;
      }
      .header .btn {
        width: 100%;
        padding: 0.7rem 1rem;
      }
      .stats-grid {
        grid-template-columns: 1fr;
      }
      .stat-item {
        padding: 1rem;
      }
      .table-box {
        background: transparent;
        border: none;
        border-radius: 0;
      }
      table, thead, tbody, th, td, tr {
        display: block;
      }
      thead {
        display: none;
      }
      .log-row {
        background: var(--card-bg);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.95rem 1rem;
        margin-bottom: 0.75rem;
        display: grid;
        grid-template-columns: 1fr auto;
        grid-template-areas:
          "date status"
          "balance reward";
        gap: 0.4rem 0.5rem;
        align-items: center;
      }
      .log-row td {
        padding: 0;
        border: none;
      }
      .col-date {
        grid-area: date;
        font-size: 0.72rem;
        color: var(--text-muted);
      }
      .col-status {
        grid-area: status;
        text-align: right;
      }
      .col-balance {
        grid-area: balance;
        font-size: 1.05rem;
        font-weight: 700;
        color: var(--text);
        margin-top: 0.2rem;
      }
      .col-reward {
        grid-area: reward;
        text-align: right;
        font-size: 0.95rem;
        font-weight: 700;
        margin-top: 0.2rem;
      }
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
      </div>
      <div class="stat-item">
        <div class="stat-label">Akun</div>
        <div class="stat-value" style="font-size: 1.1rem;">${escapeHtml(userDisplay)}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">Status Hari Ini</div>
        <div class="stat-value" style="font-size: 1.1rem; color: ${hasClaimedToday ? "var(--success-text)" : "var(--text)"};">
          ${hasClaimedToday ? "Terklaim" : "Belum Diklaim"}
        </div>
      </div>
    </section>

    <div class="section-header">
      <h2 class="section-title">Riwayat Log</h2>
    </div>

    <div class="table-box">
      <table>
        <thead>
          <tr>
            <th>Tanggal / Waktu</th>
            <th>Status</th>
            <th>Saldo</th>
            <th>Reward</th>
          </tr>
        </thead>
        <tbody id="tableBody"></tbody>
      </table>
    </div>

    <div class="pagination" id="pagination">
      <button class="btn" id="prevBtn" onclick="changePage(-1)">&lt;</button>
      <span class="page-info" id="pageInfo"></span>
      <button class="btn" id="nextBtn" onclick="changePage(1)">&gt;</button>
    </div>

    <footer class="footer">
      Cloudflare Workers &bull; agentrouter.org Auto-Claim
    </footer>
  </div>

  <script>
    const LOGS = ${logsJson};
    const PER_PAGE = 5;
    let page = 1;

    function renderTable() {
      const tbody = document.getElementById('tableBody');
      const pagination = document.getElementById('pagination');
      if (!LOGS.length) {
        tbody.innerHTML = '<tr><td colspan="3" class="empty">Belum ada riwayat tercatat.</td></tr>';
        pagination.style.display = 'none';
        return;
      }
      const totalPages = Math.max(1, Math.ceil(LOGS.length / PER_PAGE));
      if (page > totalPages) page = totalPages;
      const start = (page - 1) * PER_PAGE;
      const slice = LOGS.slice(start, start + PER_PAGE);

      tbody.innerHTML = slice.map(function (log) {
        const d = new Date(log.timestamp);
        const dateStr = d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const tag = log.success
          ? '<span class="tag tag-success">BERHASIL</span>'
          : '<span class="tag tag-failed">GAGAL</span>';
        return '<tr class="log-row">' +
          '<td class="col-date">' + dateStr + ' WIB</td>' +
          '<td class="col-status">' + tag + '</td>' +
          '<td class="col-balance">' + (log.balance || '-') + '</td>' +
          '<td class="col-reward">' + (log.success ? '<span class="reward-ok">+$25.00</span>' : '<span class="reward-none">-</span>') + '</td>' +
          '</tr>';
      }).join('');

      document.getElementById('pageInfo').innerText = page + '/' + totalPages;
      pagination.style.display = LOGS.length > PER_PAGE ? 'flex' : 'none';
      document.getElementById('prevBtn').disabled = page <= 1;
      document.getElementById('nextBtn').disabled = page >= totalPages;
    }

    function changePage(delta) {
      const totalPages = Math.max(1, Math.ceil(LOGS.length / PER_PAGE));
      page = Math.min(Math.max(1, page + delta), totalPages);
      renderTable();
    }

    renderTable();

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
