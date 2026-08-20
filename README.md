# AgentRouter Daily Auto-Claim ($25) via Cloudflare Workers

Bot gratis yang otomatis **login & klaim reward $25 harian** di [agentrouter.org](https://agentrouter.org) — berjalan di **Cloudflare Workers** (cron trigger) memakai **Browser Run** untuk menembus WAF, dengan **dashboard web** untuk memantau saldo & riwayat.

> **Kenapa butuh Browser Run?** WAF Aliyun milik AgentRouter memblokir request `fetch()` dari IP datacenter Cloudflare (buktinya: `/api/user/self` membalas HTML challenge `aliyun_waf_aa`). Browser Run menjalankan Chromium sungguhan sehingga challenge JS WAF terlewati — seperti browsing manual. Free tier: **10 menit browser/hari** — cukup untuk 1 klaim harian.

---

## ⚡ Quick Start (TL;DR)

1. **Ambil cookie GitHub** (masih login di github.com) — cara di [bagian 1](#1-persiapan-ambil-cookie-github).
2. Simpan sebagai secret: `npx wrangler secret put GITHUB_COOKIE`
3. Deploy: `bun run deploy`
4. Selesai → otomatis klaim **setiap hari 08:00 WIB**. Pantau di dashboard worker Anda.

---

## Fitur Utama

- ⏰ **Cron otomatis**: klaim berjalan sendiri setiap hari `01:00 UTC` / `08:00 WIB` — tanpa perlu buka situs atau trigger manual.
- 🌐 **Browser Run (Playwright)**: re-login OAuth via Chromium sungguhan → lolos WAF Aliyun AgentRouter.
- 📊 **Dashboard monochrome**: saldo terkini, akun, status hari ini, riwayat klaim (kolom Tanggal, Status, Saldo, Reward `+$25.00`, pagination `< 1/3 >`, 5 baris/halaman; di mobile jadi kartu responsif).
- ⚡ **Tombol Klaim Sekarang**: tes manual kapan saja, terkunci otomatis jika hari ini sudah klaim.
- 🆓 **100% gratis**: Workers Free Tier + free tier Browser Run.

---

## 1. Persiapan: Ambil Cookie GitHub

Cookie GitHub adalah "kunci login" bot Anda. Bot memakainya untuk re-login OAuth ke AgentRouter setiap hari.

> ⚠️ **Wajib salin SEMUA cookie** github.com — bukan hanya `user_session`. GitHub butuh `_gh_sess` untuk validasi form Authorize; tanpa itu klik Authorize gagal dengan halaman *"Oh no"*.

### Cara Cepat (disarankan) — via Network Tab

1. Buka `https://github.com` di browser yang **sudah login**.
2. Buka DevTools (**F12**) → tab **Network**.
3. Klik filter **`Doc`** (di barisan All / Fetch/XHR / **Doc** / ...) — hanya request halaman yang tampil.
4. **Refresh halaman** (`Ctrl + R`), lalu klik request dengan Type **`document`** (namanya biasanya `github.com` — atau nama repo yang sedang dibuka).
5. Di panel kanan → **Headers** → gulir ke **Request Headers** → salin **seluruh nilai** baris **`cookie:`** — satu string siap pakai, sudah termasuk `_gh_sess` (HttpOnly).

### Cara Alternatif — via Application Tab

1. DevTools (**F12**) → tab **Application** → **Cookies** → pilih `https://github.com`.
2. Klik baris cookie pertama → `Ctrl + A` → `Ctrl + C` → paste di Notepad.
3. Ambil kolom **Name** dan **Value**, gabung jadi satu string `nama=nilai; nama=nilai; ...` — minimal `user_session` + `_gh_sess`.

Contoh format (nilai di sini hanya contoh!):
```
user_session=gho_xxxx...; _gh_sess=eyJ...; logged_in=yes
```

> 💡 **Cookie bisa expired.** Jika sesi GitHub di-logout/di-invalidasi, klaim akan gagal — cukup salin ulang dengan cara di atas lalu update secret (lihat [Troubleshooting](#5-troubleshooting)).

---

## 2. Setup & Deploy

### Langkah 1 — Clone & install
```bash
git clone https://github.com/bismawy/agentrouter-daily.git
cd agentrouter-daily
bun install        # atau: npm install
```

### Langkah 2 — Login Cloudflare
```bash
npx wrangler login
```

### Langkah 3 — Simpan secret
```bash
# Wajib: cookie GitHub (dari bagian 1)
npx wrangler secret put GITHUB_COOKIE

# Opsional: cookie sesi agentrouter.org (cadangan fallback HTTP)
npx wrangler secret put AGENTROUTER_COOKIE
```

### Langkah 4 — Deploy
```bash
bun run deploy     # atau: npm run deploy
```

Selesai → Cloudflare menampilkan URL worker Anda: `https://agentrouter-daily.<subdomain>.workers.dev`

> Binding `[browser]` sudah dikonfigurasi di `wrangler.toml` — tanpa setup tambahan. Pastikan paket `@cloudflare/playwright` terinstall (`bun install`).

---

## 3. Penggunaan & Endpoint

Buka URL worker Anda: `https://agentrouter-daily.<subdomain>.workers.dev/`

| Endpoint | Fungsi |
|---|---|
| `/` | Dashboard: saldo, akun, status hari ini, riwayat klaim |
| `/trigger?notify=false` | Jalankan klaim manual (tes sekarang) |
| `/health` | Cek status worker & jadwal cron |
| `/api/history` | Riwayat klaim (JSON) |
| `/debug` | Diagnosa koneksi HTTP (tanpa bocorkan secret) |
| `/debug-browser` | Diagnosa alur browser step-by-step ⚠️ *habiskan kuota Browser Run* |

> ⚠️ **Hemat kuota Browser Run (10 menit/hari).** Cukup 1 klaim/hari — jangan spam `/trigger` atau `/debug-browser`.

---

## 4. Konfigurasi Jadwal Cron (Opsional)

Jadwal default ada di `wrangler.toml`:
```toml
[triggers]
crons = ["0 1 * * *"]   # 01:00 UTC = 08:00 WIB
```

Waktu lain yang umum:
| Waktu (WIB) | Cron (UTC) |
|---|---|
| 00:00 | `"0 17 * * *"` |
| 07:00 | `"0 0 * * *"` |
| 12:00 | `"0 5 * * *"` |

Setelah mengubah, deploy ulang: `bun run deploy`.

---

## 5. Troubleshooting

| Gejala | Penyebab | Solusi |
|---|---|---|
| **Dashboard "Belum Diklaim" setelah jam 08:00** | Cookie GitHub expired/logout | Salin ulang cookie (bagian 1) → `npx wrangler secret put GITHUB_COOKIE` |
| **Browser mendarat di halaman `/login` GitHub** (cek via `/debug-browser`) | Sesi GitHub tidak valid | Ganti cookie dengan yang masih login, lalu update secret |
| **Error `Invalid cookie fields` saat inject** | Karakter aneh/newline dari hasil copy | Sudah ditangani otomatis (sanitasi + skip cookie invalid). Salin ulang cookie via **Network Tab** bila tetap terjadi |
| **Halaman *"Oh no"* GitHub setelah klik Authorize** | Cookie tidak lengkap (kurang `_gh_sess`) | Salin **SEMUA** cookie, jangan cuma `user_session` |
| **Respons `/debug` berisi `aliyun_waf_aa`** | WAF memblokir pure HTTP dari Worker — **normal** | Browser Run yang menanganinya; pastikan binding `[browser]` ada & kuota Browser Run belum habis |
| **Klaim gagal tapi tidak ada error jelas** | Lihat jalur error | Cek `/debug-browser` (step-by-step) atau `npx wrangler tail` saat trigger |

---

## 6. Struktur Proyek

```
agentrouter-daily/
├── src/
│   ├── index.ts          # Entry point: routing, cron trigger, wrapper runClaim()
│   ├── browser-claim.ts  # Klaim via Cloudflare Browser Run (Playwright) — jalur utama
│   ├── agentrouter.ts    # Pure HTTP OAuth chain (fallback) + util cookie & self-check
│   ├── dashboard.ts      # Render dashboard (tabel/kartu responsif + pagination)
│   ├── history.ts        # Simpan/baca riwayat klaim (cache)
│   ├── notifier.ts       # Notifikasi (opsional)
│   └── types.ts          # Tipe data & interface env
├── wrangler.toml         # Konfigurasi worker, binding [browser], cron trigger
└── package.json
```

---

## 7. Keamanan & Privasi

- **`GITHUB_COOKIE` adalah kredensial sesi pribadi.** Simpan hanya sebagai Cloudflare Secret — jangan pernah tulis di kode, README, atau commit.
- `.env`, `.env.*`, dan `.dev.vars` sudah masuk `.gitignore` — tidak akan pernah ter-commit.
- Jika cookie bocor/terbagi: segera log out sesi lain di GitHub (*Settings → Sessions*), lalu salin ulang cookie.
- Repo ini **tidak berisi nilai cookie asli** — yang ada hanya placeholder contoh.
