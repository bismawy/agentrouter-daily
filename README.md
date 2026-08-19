# AgentRouter Daily Auto-Claim ($25) via Cloudflare Workers

Sistem otomatis untuk login dan klaim reward $25 harian di [agentrouter.org](https://agentrouter.org) menggunakan **Cloudflare Workers Cron Triggers + Browser Run (Browser Rendering)** dan dilengkapi **Web Dashboard Monochrome Minimalis**.

> **Kenapa Browser Run?** WAF Aliyun milik AgentRouter memblokir request `fetch()` dari IP datacenter Cloudflare Workers (dibuktikan lewat endpoint `/debug`: respons `/api/user/self` berupa HTML challenge `aliyun_waf_aa`). Browser Run menjalankan browser Chromium sungguhan yang bisa melewati challenge JS WAF tersebut — sama seperti browser biasa. Free tier: **10 menit browser/hari**, cukup untuk 1 klaim harian.

---

## Fitur Utama

- ⏰ **Scheduled Cron Trigger**: Berjalan otomatis setiap hari pukul `01:00 UTC` / `08:00 WIB`.
- 📊 **Web Dashboard Monochrome**: UI minimalis font **Geist Mono** — saldo terkini, status hari ini, dan riwayat klaim. Di desktop berupa tabel (kolom Tanggal, Status, Saldo, Reward); di mobile berubah jadi kartu responsif tanpa scroll. Riwayat dibatasi **5 data/halaman** dengan pagination `< 1/3 >`.
- ⚡ **Tombol Klaim Instan**: Tombol interaktif `[ Klaim Sekarang ]` dengan proteksi anti-spam (maksimal 1 kali klaim per hari).
- 🍪 **Auto User Extraction**: Otomatis mendeteksi identitas & ID user dari cookie session.
- 🆓 **100% Serverless & Gratis**: Dijalankan di atas Cloudflare Workers Free Tier (termasuk free tier Browser Run 10 menit/hari).
- 🌐 **Browser Run**: Login ulang OAuth via browser Chromium sungguhan → lolos WAF Aliyun AgentRouter.

---

## 1. Persiapan: Ambil Cookie GitHub & Session

### A. Ambil Cookie GitHub (Wajib untuk Auto Re-login & Klaim $25)
> **Penting:** Salin **SEMUA cookie** github.com (bukan hanya `user_session`). GitHub mewajibkan cookie `_gh_sess` untuk validasi form persetujuan OAuth (tanpa itu, klik "Authorize" gagal dengan halaman error "Oh no").

#### Cara Cepat (Disarankan) — via Network Tab
1. Buka browser yang sudah login akun GitHub Anda di `https://github.com`.
2. Buka **Developer Tools** (`F12`) > tab **Network**.
3. Klik filter **`Doc`** di baris jenis resource (All / Fetch/XHR / **Doc** / ...) — hanya request halaman (`document`) yang tampil.
4. Cari request bernama **`agentrouter-daily`** (Type: `document`).
5. Klik request tersebut > panel kanan > **Headers** > **Request Headers** > salin **seluruh nilai** baris **`cookie:`** — satu string siap pakai, berisi semua cookie termasuk `_gh_sess` (HttpOnly).

#### Cara Alternatif — via Application Tab
1. Buka **Developer Tools** (`F12`) > tab **Application** (atau **Storage**) > **Cookies** > pilih `https://github.com`.
2. Klik baris cookie pertama > `Ctrl + A` (pilih semua) > `Ctrl + C` (salin) > paste di Notepad.
3. Ambil kolom **Name** dan **Value** saja, gabung jadi satu string dengan format `nama=nilai; nama=nilai; ...` — minimal sertakan `user_session` dan `_gh_sess`.

Contoh:
```
user_session=gho_xxxx...; _gh_sess=eyJ...; logged_in=yes
```

### B. Ambil Cookie AgentRouter (Opsional / Cadangan)
1. Buka browser dan login ke `https://agentrouter.org`.
2. Buka **Developer Tools** (`F12`) > tab **Network** > filter `self`.
3. Refresh halaman (`Ctrl + R`), klik request `self`, lalu salin seluruh nilai header `cookie:`.

---

## 2. Setup & Deploy ke Cloudflare

### Langkah 1: Clone Repository
```bash
git clone https://github.com/bismawy/agentrouter-daily.git
cd agentrouter-daily
bun install   # atau: npm install
```

### Langkah 2: Login ke Cloudflare
```bash
npx wrangler login
```

### Langkah 3: Simpan Secrets ke Cloudflare
```bash
# Wajib: Cookie GitHub untuk memicu auto re-login OAuth & klaim $25
npx wrangler secret put GITHUB_COOKIE

# Opsional: Cookie AgentRouter
npx wrangler secret put AGENTROUTER_COOKIE
```

### Langkah 4: Deploy Worker
```bash
bun run deploy
# atau
npm run deploy
```

Setelah selesai, Cloudflare akan menampilkan tautan publik worker Anda:
`https://agentrouter-daily.<subdomain>.workers.dev`

> Binding `[browser]` sudah dikonfigurasi di `wrangler.toml` — tidak perlu setup tambahan. Browser Run tersedia di Workers Free (10 menit browser/hari).

---

## 3. Cara Penggunaan & Pengecekan

Buka tautan worker Anda di browser:
👉 **`https://agentrouter-daily.<subdomain>.workers.dev/`**

Di halaman tersebut akan tampil:
- **Saldo Terkini**: Total akumulasi credit ($USD).
- **Akun**: Info akun GitHub yang terhubung.
- **Status Hari Ini**: `Terklaim` / `Belum Diklaim`.
- **Riwayat Log**: Tabel tanggal, status klaim (`BERHASIL` / `GAGAL`), saldo, dan reward `+$25.00` — maksimal 5 data per halaman (pagination `< 1/3 >`). Di mobile tampil sebagai kartu responsif.
- **Tombol `[ Klaim Sekarang ]`**: Untuk cek langsung tanpa menunggu jadwal cron harian (otomatis terkunci jika sudah klaim hari ini).

---

## 5. Struktur Proyek

```
agentrouter-daily/
├── src/
│   ├── index.ts          # Entry point worker: routing, cron trigger, wrapper runClaim()
│   ├── browser-claim.ts  # Klaim via Cloudflare Browser Run (Playwright) — jalur utama
│   ├── agentrouter.ts    # Pure HTTP OAuth chain (fallback) + util cookie & self-check
│   ├── dashboard.ts      # Render web dashboard (tabel/kartu responsif + pagination)
│   ├── history.ts        # Simpan/baca riwayat klaim (cache)
│   ├── notifier.ts       # Notifikasi (opsional)
│   └── types.ts          # Tipe data & interface env
├── wrangler.toml         # Konfigurasi Worker, binding [browser], cron trigger
└── package.json
```

---

## 6. Keamanan & Privasi

- **Cookie GitHub (`GITHUB_COOKIE`)** adalah kredensial sesi pribadi. Simpan **hanya** sebagai Cloudflare Secret — jangan pernah menuliskannya di kode, README, atau commit.
- File `.env`, `.env.*`, dan `.dev.vars` sudah masuk `.gitignore` sehingga tidak akan pernah ter-commit ke repo publik.
- Jika cookie GitHub bocor/terbagi, segera **logout sesi lain** di GitHub → *Settings → Sessions* lalu salin ulang cookie.
- Client ID GitHub AgentRouter bersifat publik (aman untuk dibagikan); yang sensitif hanya nilai cookie-nya.

---

## 4. Konfigurasi Jadwal Cron (Opsional)

Jadwal otomatisasi diatur di file `wrangler.toml`:
```toml
[triggers]
crons = ["0 1 * * *"] # Setiap hari pukul 01:00 UTC (08:00 WIB)
```

Untuk mengubah waktu eksekusi:
- Pukul 00:00 WIB: `"0 17 * * *"`
- Pukul 07:00 WIB: `"0 0 * * *"`
- Pukul 12:00 WIB: `"0 5 * * *"`

Setelah mengubah `wrangler.toml`, deploy ulang dengan `bun run deploy`.
