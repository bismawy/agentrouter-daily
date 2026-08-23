# AgentRouter Daily Auto-Claim ($25) via Cloudflare Workers

Bot gratis yang otomatis **login & klaim reward $25 harian** di [agentrouter.org](https://agentrouter.org) — berjalan di **Cloudflare Workers** (cron trigger) memakai **Browser Run** untuk menembus WAF, dengan **dashboard web** untuk memantau saldo & riwayat.

> **Kenapa butuh Browser Run?** WAF Aliyun milik AgentRouter memblokir request `fetch()` dari IP datacenter Cloudflare (buktinya: `/api/user/self` membalas HTML challenge `aliyun_waf_aa`). Browser Run menjalankan Chromium sungguhan sehingga challenge JS WAF terlewati — seperti browsing manual. Free tier: **10 menit browser/hari** — alur di bawah dirancang supaya hari-hari normal hanya memakai ±30 detik.

---

## ⚡ Quick Start (TL;DR)

1. **Ambil cookie GitHub** (masih login di github.com) — cara di [bagian 1](#1-persiapan-ambil-cookie-github).
2. Simpan sebagai secret: `npx wrangler secret put GITHUB_COOKIE`
3. Deploy: `bun run deploy`
4. Selesai → otomatis klaim **setiap hari 08:00 WIB** (+ retry 14:00 WIB). Pantau di dashboard worker Anda.

---

## Fitur Utama

- ⏰ **Cron otomatis + retry**: klaim berjalan sendiri setiap hari `08:00 WIB`; bila gagal, diulang `14:00 WIB`. Setiap eksekusi dimulai dengan **cek murah tanpa browser** — kalau reward hari ini sudah aktif, langsung skip (kuota Browser Run tidak terpakai).
- 🔑 **Sesi tersimpan otomatis (Durable Object)**: setelah login sukses, cookie sesi AgentRouter disimpan. Hari berikutnya cukup *quick check* 1 halaman — **tanpa menari OAuth GitHub lagi** selama sesi masih hidup.
- ✅ **Verifikasi reward nyata**: sukses tidak lagi sekadar "API membalas data". Bot membandingkan `quota` sebelum vs sesudah login — kenaikan ≥ $25 ditandai **TERVERIFIKASI** di pesan & dashboard (`+$25.00` vs `+$25.00*`).
- 🌐 **Browser Run (Playwright)**: saat sesi habis, re-login OAuth via Chromium sungguhan → lolos WAF Aliyun. Gagal cepat + pesan jelas untuk cookie GitHub mati, halaman verifikasi perangkat GitHub, dan kuota browser habis (429).
- 📊 **Dashboard monochrome**: saldo terkini, akun, status hari ini, riwayat klaim (pagination `< 1/3 >`, 5 baris/halaman; di mobile jadi kartu responsif).
- 🔒 **Proteksi endpoint**: bila secret `TRIGGER_AUTH_KEY` disetel, semua endpoint mahal/sensitif (`/trigger`, `/debug-browser`, `/clean-history`, `/api/history`, `/debug`) wajib `?key=...`.
- 🧱 **Lock anti-dobel**: cron & trigger manual tidak bisa berjalan bersamaan (lock otomatis 10 menit di Durable Object).
- 🆓 **100% gratis**: Workers Free Tier + free tier Browser Run.

---

## 1. Persiapan: Ambil Cookie GitHub

Cookie GitHub adalah "kunci login" bot Anda. Bot memakainya untuk re-login OAuth ke AgentRouter saat sesi tersimpan sudah tidak berlaku.

> ⚠️ **Wajib salin SEMUA cookie** github.com — bukan hanya `user_session`. GitHub butuh `_gh_sess` untuk validasi form Authorize; tanpa itu klik Authorize gagal dengan halaman *"Oh no"*. (Bot otomatis me-refresh `_gh_sess` dari `user_session` setiap berjalan, tapi `user_session` wajib valid.)

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

> 💡 **Cookie bisa expired.** Jika sesi GitHub di-logout/di-invalidasi, bot akan gagal dengan pesan jelas — cukup salin ulang cookie lalu update secret (lihat [Troubleshooting](#5-troubleshooting)).

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

# Sangat disarankan: kunci proteksi endpoint manual
npx wrangler secret put TRIGGER_AUTH_KEY

# Opsional: cookie sesi agentrouter.org (cadangan baca saldo)
npx wrangler secret put AGENTROUTER_COOKIE
```

### Langkah 4 — Deploy
```bash
bun run deploy     # atau: npm run deploy
```

Selesai → Cloudflare menampilkan URL worker Anda: `https://agentrouter-daily.<subdomain>.workers.dev`

> Binding `[browser]` dan Durable Object `[STATE]` sudah dikonfigurasi di `wrangler.toml` — **semua dibuat otomatis saat deploy**, tanpa setup tambahan. Pastikan paket `@cloudflare/playwright` terinstall (`bun install`).

---

## 3. Cara Kerja Alur Klaim

```
Cron 08:00 / 14:00 WIB
│
├─ Cek murah (tanpa browser): last_login hari ini sudah tercatat? → SELESAI (skip)
│
├─ Ada sesi tersimpan? ── QUICK CHECK (1 halaman browser, ±30 dtk)
│    ├─ last_login hari ini → reward sudah aktif → SELESAI ✅
│    ├─ sesi hidup, belum login hari ini → lanjut OAuth (baseline quota segar)
│    └─ sesi mati → hapus sesi, lanjut OAuth
│
└─ OAUTH PENUH (Browser Run): refresh _gh_sess → GitHub authorize →
     callback AgentRouter → baca saldo → VERIFIKASI naik ≥ $25 →
     simpan sesi baru untuk besok → (fallback Pure HTTP bila browser gagal)
```

- **Verifikasi**: `+$25.00` = kenaikan saldo terukur langsung; `+$25.00*` = login hari ini aktif tapi kenaikan tidak terukur (mis. reward sudah diklaim sebelumnya hari itu).
- **Login manual Anda di agentrouter.org tetap dihitung** — kalau Anda sudah login sendiri hari itu, bot mendeteksinya via quick check dan tidak membakar kuota browser.

## Endpoint

Buka URL worker Anda: `https://agentrouter-daily.<subdomain>.workers.dev/`

| Endpoint | Fungsi | Key? |
|---|---|---|
| `/` | Dashboard: saldo, akun, status hari ini, riwayat klaim | — |
| `/health` | Cek status worker & jadwal cron | — |
| `/trigger?notify=false` | Jalankan klaim manual (tes sekarang) | 🔒 |
| `/api/history` | Riwayat klaim (JSON) | 🔒 |
| `/debug` | Diagnosa koneksi HTTP (tanpa bocorkan secret) | 🔒 |
| `/debug-browser` | Diagnosa alur browser step-by-step ⚠️ *habiskan kuota Browser Run* | 🔒 |
| `/clean-history` | Kosongkan riwayat log (sesi & snapshot tetap tersimpan) | 🔒 |

🔒 = bila `TRIGGER_AUTH_KEY` disetel, tambahkan `?key=<kunci>` atau header `x-auth-key`.

> ⚠️ **Hemat kuota Browser Run (10 menit/hari).** Quick check hemat kuota, tapi OAuth penuh + `/debug-browser` tetap mahal. Dashboard bisa dibuka kapan saja tanpa memakai browser.

---

## 4. Konfigurasi Jadwal Cron (Opsional)

Jadwal default ada di `wrangler.toml`:
```toml
[triggers]
crons = ["0 1 * * *", "0 7 * * *"]   # 08:00 & 14:00 WIB
```

> ⚠️ **Workers Free membatasi 5 cron trigger per akun** (semua worker dijumlahkan). Worker ini memakai 2 slot. Kalau deploy gagal dengan error `10072`, kurangi jadwal di atas atau hapus cron dari worker lain di akun Anda.

Waktu lain yang umum:
| Waktu (WIB) | Cron (UTC) |
|---|---|
| 00:00 | `"0 17 * * *"` |
| 07:00 | `"0 0 * * *"` |
| 12:00 | `"0 5 * * *"` |

Setelah mengubah, deploy ulang: `bun run deploy`. Eksekusi tambahan aman — bila reward hari itu sudah aktif, cron langsung skip tanpa memakai browser.

---

## 5. Troubleshooting

| Gejala | Penyebab | Solusi |
|---|---|---|
| **Pesan "GITHUB_COOKIE tidak valid — halaman login"** | Cookie GitHub expired/logout | Salin ulang cookie ([bagian 1](#1-persiapan-ambil-cookie-github)) → `npx wrangler secret put GITHUB_COOKIE` |
| **Pesan "VERIFIKASI PERANGKAT (device verification)"** | GitHub mencurigai sesi dari IP browser Cloudflare | Buka github.com di browser biasa, selesaikan verifikasi/email, login ulang, salin ulang cookie |
| **Pesan "Kuota Browser Run habis (429)"** | Free tier 10 menit/hari terpakai (spam `/trigger`, `/debug-browser`, atau OAuth berulang) | Tunggu reset 00:00 UTC (07:00 WIB); retry cron otomatis akan mencoba lagi |
| **`+$25.00*` (berhasil tapi tidak terverifikasi)** | Reward hari itu sudah diklaim sebelumnya (login manual / run tadi) | Normal — tidak perlu tindakan |
| **Dashboard "Belum Diklaim" padahal klaim sukses** | Sebelumnya riwayat disimpan di cache per-datacenter (bug lama); kini di Durable Object | Deploy versi baru; klik "Klaim Sekarang" sekali untuk sinkron |
| **Error `Invalid cookie fields` saat inject** | Karakter aneh/newline dari hasil copy | Sudah ditangani otomatis (sanitasi + skip cookie invalid) |
| **Halaman *"Oh no"* GitHub setelah klik Authorize** | Cookie tidak lengkap (kurang `_gh_sess`) | Salin **SEMUA** cookie, jangan cuma `user_session` |
| **Respons `/debug` berisi `aliyun_waf_aa`** | WAF memblokir pure HTTP dari Worker — **normal** | Browser Run yang menanganinya; pastikan binding `[browser]` ada & kuota belum habis |
| **Klaim gagal tapi tidak ada error jelas** | Lihat jalur error | Cek `/debug-browser` (step-by-step) atau `npx wrangler tail` saat trigger |

---

## 6. Struktur Proyek

```
agentrouter-daily/
├── src/
│   ├── index.ts          # Entry: routing, cron retry, lock, orkestrasi quick-check → OAuth
│   ├── browser-claim.ts  # Browser Run: quick-check sesi, OAuth penuh, fail-fast GitHub
│   ├── agentrouter.ts    # Pure HTTP OAuth (fallback) + util cookie & verifikasi reward
│   ├── state.ts          # Durable Object StateStore: sesi, snapshot, riwayat, lock
│   ├── dashboard.ts      # Render dashboard (tabel/kartu responsif + pagination)
│   ├── history.ts        # Riwayat klaim (tersimpan di Durable Object)
│   ├── notifier.ts       # Notifikasi Telegram/Discord (opsional)
│   └── types.ts          # Tipe data & interface env
├── wrangler.toml         # Konfigurasi worker, [browser], [durable_objects], cron
└── package.json
```

---

## 7. Keamanan & Privasi

- **`GITHUB_COOKIE` adalah kredensial sesi pribadi.** Simpan hanya sebagai Cloudflare Secret — jangan pernah tulis di kode, README, atau commit.
- **Sesi AgentRouter tersimpan di Durable Object** worker Anda sendiri (tidak keluar dari akun Cloudflare Anda) sehingga hari berikutnya tidak perlu OAuth dari nol.
- Setel `TRIGGER_AUTH_KEY` agar orang lain yang menemukan URL worker tidak bisa memicu klaim / membakar kuota `/debug-browser`.
- `.env`, `.env.*`, dan `.dev.vars` sudah masuk `.gitignore` — tidak akan pernah ter-commit.
- Jika cookie bocor/terbagi: segera log out sesi lain di GitHub (*Settings → Sessions*), lalu salin ulang cookie.
- Repo ini **tidak berisi nilai cookie asli** — yang ada hanya placeholder contoh.
