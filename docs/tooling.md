# Agent araçları: MCP sunucuları ve skill'ler

Dört satıcı için "HeroUI'de olan şey bunda da var mı" sorusu araştırıldı.
Cevap ikisinde evet, ikisinde **kesin hayır** — ve hayır olanlar önemli, çünkü
her ikisinin de npm'de resmî görünen bir taklidi var.

## Eklenenler

| Ne | Nerede | Doğrulama |
|---|---|---|
| **Vercel MCP** | `.mcp.json` → `vercel` | `https://mcp.vercel.com` 401 + geçerli OAuth metadata döndü, `resource_name: "Vercel MCP"` |
| **Next.js MCP** | `.mcp.json` → `next-devtools` | `next-devtools-mcp@0.4.0`, repo `vercel/next-devtools-mcp`, publisher `vercel-release-bot <infra+release@vercel.com>` |
| **Next.js skill** | `.claude/skills/next-dev-loop/` | `vercel/next.js` deposundan `v16.3.5` etiketinden birebir çekildi |

**Vercel MCP** HTTP + OAuth 2.1. Depoya işlenmeye en uygun tip: dosyada hiçbir
gizli bilgi durmuyor, kimlik doğrulama tarayıcıda kişi başına yapılıyor. Ama bunun
diğer yüzü var — depoyu klonlayan herkesin `/mcp` ile kendi yetkilendirmesini
yapması gerekiyor, ve yetki verdiğinde ajan o kişinin Vercel hesabının erişimini
alıyor: deployment'lar, proje ayarları, log'lar.

**Next.js MCP** stdio, kimlik doğrulama yok, yalnız localhost. Next 16 dev
sunucusunda `/_next/mcp` endpoint'ini açıyor; bu paket ona köprü. `get_errors`,
`get_routes`, `get_compilation_issues` gibi araçlar veriyor. İki kayıt: **0.4.0,
yani 1.0 öncesi** (araç isimleri minor sürümlerde değişebilir) ve **yalnız dev
modunda işe yarıyor** — `next dev` çalışmıyorsa boş dönüyor.

**Next.js skill'i** `npx skills add ...` ile değil, doğrudan etiketli sürümden
çekildi. Gerekçesi `.claude/skills/next-dev-loop/PROVENANCE.md`'de.

## Eklenmeyenler, ve neden

### React — resmî hiçbir şey yok

React ekibi MCP sunucusu yayınlamıyor. Dört ayrı yolla doğrulandı: `@react/mcp`,
`@reactjs/mcp`, `@react/mcp-server`, `react-mcp-server` hepsi npm'de 404;
`facebook/react` deposunda `.mcp.json` yok.

npm'de `react-mcp` **var** ve sorunsuz kurulur — ama publisher'ı
`abai <aiden.bai05@gmail.com>`, yani bir şahıs. Meta değil.

Ayrıca bu projede React'e özgü bir şey eklemenin kazancı da zayıf: gerçekten
önemli olan React konuları Server/Client Component ayrımı ve `'use client'`
sınırı, ve ikisi de Next.js'in dokümante ettiği şeyler.

### Tailwind CSS v4 — resmî hiçbir şey yok

Tailwind Labs MCP sunucusu yayınlamıyor. `@tailwindcss/mcp`, `@tailwindlabs/mcp`,
`@tailwindcss/mcp-server`, `tailwind-mcp` hepsi 404.

npm'de `tailwindcss-mcp@1.1.0` **var** — publisher'ı
`void_december <a.s.nekrassov@gmail.com>`. Tailwind Labs değil.

`tailwindcss.com` makine-okunur doküman da yayınlamıyor: `/llms.txt` ve
`/llms-full.txt` 404, doküman sayfalarına `.md` eklemek de 404. llms.txt ekleyen
bir topluluk PR'ı reddedilmiş.

Tailwind 4 tarafında gerçek risk şu ve duruyor: v4, v3'ten büyük bir kopuş
(CSS-first `@theme`, `@utility`, `@custom-variant`, varsayılan olarak
`tailwind.config.js` yok, bundler başına ayrı eklenti). Çoğunlukla v3 üzerine
eğitilmiş bir ajan bunu yanlış yapıyor. Şimdilik bunu karşılayan şey mevcut
**HeroUI skill'i** — kendisi "Tailwind CSS v4 + React Aria" için yazılmış ve
oklch değişkenleri ile tema kurulumunu kapsıyor. Ayrı bir Tailwind skill'i
yazmak mümkün, ama o **resmî olmaz** — bizim yazdığımız bir şey olur, ve
mevcut olanla örtüşür.

## Kural

**Vercel, Next.js, React ve Tailwind 4 için üçüncü parti MCP sunucusu veya skill
kullanılmıyor.** Bunlar için yalnız satıcının kendi yayınladığı şey kabul ediliyor;
resmî karşılığı yoksa **hiçbir şey eklenmiyor.** Proje kararı.

Bir paketin resmî olup olmadığı isminden değil **publisher'ından** anlaşılıyor:

```bash
npm view <paket> maintainers repository.url
```

`react-mcp`, `tailwindcss-mcp` ve `add-mcp` üçü de bu testte şahıs hesabı
çıkıyor. Üçü de kurulur, üçü de çalışabilir, ama hiçbiri iddia ettiği satıcının
değil.

## Denetim

Kurulu olan her şeyin publisher'ı doğrulandı:

| Giriş | Kaynak | Publisher | Sonuç |
|---|---|---|---|
| `vercel` (MCP) | `https://mcp.vercel.com` | `authorization_servers: vercel.com`, `resource_name: "Vercel MCP"` | Vercel'in kendi endpoint'i |
| `next-devtools` (MCP) | `next-devtools-mcp@0.4.0` | `vercel-release-bot <infra+release@vercel.com>`, repo `vercel/next-devtools-mcp` | Vercel |
| `next-dev-loop` (skill) | `vercel/next.js` @ `v16.3.5` | depo etiketinden birebir | Vercel |
| React | — | — | **hiçbir şey kurulu değil** |
| Tailwind 4 | — | — | **hiçbir şey kurulu değil** |
| `heroui-react` (MCP) | `@heroui/react-mcp@1.1.2` | `juniorgarciadev`, repo `heroui-inc/heroui-mcp` | HeroUI — aşağıdaki nota bak |

İki nokta dürüstçe kayda geçsin:

**1. `@heroui/react-mcp` şahıs hesabından yayınlanıyor.** Maintainer
`juniorgarciadev <jrgarciadev@gmail.com>` — HeroUI'nin kurucusu, ama bir org bot'u
değil. Resmî olduğunu gösteren şey `@heroui` **scope'u** (scope'lu pakete yayın
yapmak org üyeliği gerektiriyor) ve deponun `heroui-inc` altında olması. HeroUI bu
kuralın kapsadığı dört satıcıdan biri değil ve kurulumu ayrıca istenmişti, o yüzden
duruyor. Tablodaki tek "publisher bir kişi" satırı bu.

**2. `next-dev-loop` skill'i `agent-browser` kurmayı söylüyor.** Doğrulandı: repo
`vercel-labs/agent-browser`, maintainer'ları arasında `vercel-release-bot` ve
`zeit-bot` var — yani **Vercel'in kendi paketi**, üçüncü parti değil. Yine de
**kurulu değil**, dolayısıyla skill'in tarayıcı yarısı çalışmıyor; `/_next/mcp`
yarısı `agent-browser` olmadan da çalışıyor. Skill'in dosyasında Playwright'a
referans yok.

## MCP onayı

Bir MCP sunucusu `.mcp.json`'a yazılmakla çalışmaya başlamıyor — Claude Code
onay istiyor. Bu kasıtlı ve atlatılmaması gereken bir şey: bir depo, klonlayan
kişinin ajanında kendi başına süreç başlatamamalı. `/mcp` ile onayla.
