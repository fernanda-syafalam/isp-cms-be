Table of Contents

# Backend Engineering Best Practices — NestJS Edition

**Versi 2.0 — Fastify + Drizzle Stack** *Standar Internal Tim Engineering — April 2026*

Konvensi spesifik NestJS untuk membangun service produksi yang konsisten, dengan Fastify adapter sebagai HTTP layer dan Drizzle ORM sebagai data access layer.

## Daftar Isi

1.  [Pendahuluan](#bookmark=id.909b7mwk57ns)

2.  [Pilar 1 — Arsitektur & Struktur Project](#bookmark=id.swmcp6jylgbe)

3.  [Pilar 2 — API Design](#bookmark=id.8zp861vq9iws)

4.  [Pilar 3 — Database & Data Layer (Drizzle)](#bookmark=id.8nnyjjgjf7wc)

5.  [Pilar 4 — Security](#bookmark=id.22f8cipg3x2x)

6.  [Pilar 5 — Testing (Vitest)](#bookmark=id.7dizqirxiy7f)

7.  [Pilar 6 — Observability (OpenTelemetry + Grafana)](#bookmark=id.vwtw6upynxdv)

8.  [Pilar 7 — Background Jobs & Queues (BullMQ)](#bookmark=id.mce9ymjgplnr)

9.  [Pilar 8 — Migrations Strategy](#bookmark=id.5lwlucczbzsp)

10. [Pilar 9 — Containerization & Deployment](#bookmark=id.4ci0vcq0rfdj)

11. [Common Pitfalls NestJS + Fastify + Drizzle](#bookmark=id.jqkhl0t8ehco)

12. [Tooling Stack Rekomendasi](#bookmark=id.q514jsi6ox01)

13. [Lampiran A — Code Review Checklist](#bookmark=id.lgz3se4u20ry)

14. [Lampiran B — Migration Guide v1.0 → v2.0](#bookmark=id.kwyzb7iovrpe)

## Pendahuluan

### Tujuan dokumen

Dokumen ini adalah standar internal tim untuk membangun backend service NestJS yang siap-produksi, dengan **Fastify sebagai HTTP adapter** dan **Drizzle sebagai ORM**. Berbeda dari panduan “backend Node.js umum”, dokumen ini fokus pada konvensi spesifik kombinasi NestJS + Fastify + Drizzle — kapan pakai Guard versus Interceptor, bagaimana wire Fastify plugin di NestJS lifecycle, kapan repository mengembalikan domain type versus Drizzle row, kapan transaction harus dipropagasi versus di-scope ulang.

Setiap pilar disusun dengan struktur konsisten: **Prinsip → Aturan praktis → Contoh kode → Anti-pattern → Definition of Done**. Audience-nya tim campuran — junior bisa belajar dari contoh decorator dan struktur module, senior bisa menemukan rationale di balik tiap rekomendasi dan referensi untuk argumen di code review.

Dokumen ini opinionated. Setiap “lakukan X” datang dengan alasan singkat. Kalau ada hedge “tergantung”, itu disertai kriteria keputusan konkret — bukan eskapisme.

### Cara membaca dokumen ini

- **Engineer baru di stack ini (week 1–2):** baca berurutan, fokus pada contoh kode dan anti-pattern. Coba bangun service kecil mengikuti struktur folder di Pilar 1.

- **Saat menulis fitur baru:** baca pilar yang relevan untuk memastikan tidak melanggar konvensi. Definition of Done di akhir pilar adalah self-check terakhir sebelum buka PR.

- **Saat code review:** pakai Lampiran A (Code Review Checklist) sebagai referensi cepat. Untuk argumen yang lebih panjang, link ke section spesifik di dokumen ini.

- **Saat ada perdebatan teknis:** cari section yang relevan. Kalau dokumen diam, itu sinyal keputusan tingkat tim — angkat ke diskusi, lalu update dokumen.

### Asumsi stack

Rekomendasi di dokumen ini ditulis dengan asumsi stack berikut. Ini **bukan** menu pilihan — ini adalah standar default untuk service baru. Penyimpangan dibahas di review arsitektur, bukan di-decide ad-hoc.

| Layer | Pilihan | Alasan singkat |
|----|----|----|
| Runtime | Node.js 20 LTS atau 22 LTS | Stable, performa V8 modern, native test runner & fetch |
| Bahasa | TypeScript 5.x dengan strict: true | Type safety end-to-end, terutama dengan Drizzle inference |
| Framework | NestJS 10+ | Module system, DI container, decorator-driven |
| HTTP adapter | **Fastify** (@nestjs/platform-fastify) | 2–3x throughput vs Express, JSON schema validation, plugin ecosystem matang |
| ORM | **Drizzle ORM** + drizzle-kit | Type-safe SQL, schema-first, migration first-class, no runtime overhead |
| Database | PostgreSQL 16+ | Default tim untuk OLTP. Pakai pg driver, bukan postgres-js, untuk kompatibilitas pool standar |
| Cache | Redis 7+ via @nestjs/cache-manager (cache-manager v5+) | In-memory cache shared antar instance |
| Queue | BullMQ via @nestjs/bullmq | Berbasis Redis, retry/backoff/scheduling matang |
| Validation | zod via nestjs-zod | Single source of truth dengan config validation; lihat Pilar 2 |
| Auth | @nestjs/passport + passport-jwt | Integrasi NestJS native, JWT stateless |
| Logger | nestjs-pino | JSON output, low overhead, integrasi request-id Fastify |
| Observability | OpenTelemetry SDK → Tempo (trace) / Loki (log) / Mimir-Prometheus (metric) | Vendor-neutral, single instrumentation untuk semua signal |
| Testing | **Vitest** + supertest (via Fastify inject) + Testcontainers | Lebih cepat dari Jest, native ESM, kompatibel API |
| Linter/Formatter | **Biome** (lihat Tooling) | Single tool untuk lint+format, ~25x lebih cepat dari ESLint+Prettier |
| Container | Multi-stage Docker, distroless runtime | Image kecil, attack surface minimal |
| Orchestration | Kubernetes (atau ECS Fargate untuk service kecil) | Default infra tim |

### Beda dari Versi 1.0

V1.0 menempatkan Express adapter dan Prisma sebagai default, dengan Fastify dan Drizzle disebut sebagai alternatif. V2.0 membalik posisi ini: Fastify dan Drizzle adalah default, dan Express/Prisma tidak lagi dibahas kecuali di Lampiran B (Migration Guide).

Perubahan substantif dari v1.0: - Semua contoh main.ts pakai NestFastifyApplication + FastifyAdapter. - Semua contoh repository pakai Drizzle schema dan query builder. - Validation default berpindah dari class-validator ke zod (via nestjs-zod) — alasannya konsistensi dengan validasi config dan inferensi type yang lebih bersih untuk DTO. - Testing pindah dari Jest ke Vitest. Supertest tetap dipakai, tapi untuk e2e Fastify direkomendasikan app.getHttpAdapter().getInstance().inject(...) yang lebih cepat. - Pilar baru: Background Jobs (BullMQ), Migrations Strategy (drizzle-kit), Containerization & Deployment (Docker + K8s). - Common Pitfalls direvisi: pitfall Express/Prisma dihapus, pitfall Fastify/Drizzle/BullMQ ditambahkan.

### Bagaimana dokumen ini diperbarui

Dokumen ini hidup. Saat tim memutuskan mengubah atau menambah konvensi, perubahan masuk lewat PR ke repo dokumen ini, dengan diskusi di review. Tidak ada “otoritas tunggal” — engineer manapun boleh propose perubahan, asal disertai alasan dan contoh. Aturan praktisnya: kalau Anda tiga kali bilang “harusnya dokumen menyebutkan ini”, buat PR.

## Pilar 1 — Arsitektur & Struktur Project

### Prinsip

NestJS adalah framework opinionated — module, provider, dan DI container-nya sudah memberi struktur. Tugas Anda bukan melawan konvensi NestJS, tapi memakainya dengan disiplin: **satu module per bounded context, controller tipis, service yang bisa di-test tanpa menjalankan aplikasi, repository sebagai pintu satu-satunya ke database**, dan tidak menyalahgunakan global state.

Fastify adapter mengubah beberapa detail (lifecycle hook, request/reply object, plugin registration), tapi tidak mengubah filosofi struktur. Drizzle mengubah cara repository ditulis tapi tidak mengubah peran repository itu sendiri.

### Aturan praktis

- **Satu module per bounded context** (UsersModule, OrdersModule, BillingModule). Module tidak dipotong by tipe — ControllersModule dan ServicesModule adalah anti-pattern.

- **Controller hanya menangani HTTP concern**: parse request via DTO, panggil service, return response. Tidak ada business logic, tidak ada query database.

- **Service injectable dengan @Injectable()**. Dependency lewat constructor injection. Hindari property injection (@Inject() di property) kecuali untuk circular dependency yang tidak terhindarkan — dan kalau itu terjadi, refactor lebih baik.

- **Repository di-abstract sebagai class injectable**. Service tidak meng-import drizzle atau db langsung. Ini mempermudah unit test dan menjaga aturan: service tidak tahu tentang SQL.

- **Konfigurasi pakai @nestjs/config + zod** untuk validasi. Aplikasi gagal saat startup kalau config invalid, bukan saat request pertama.

- **Hindari forwardRef()** kecuali benar-benar terpaksa. Circular dependency hampir selalu sinyal pemisahan module yang salah.

- **Hindari @Global()** kecuali untuk modul infrastructure (Database, Logger, Cache, Config). Global module yang business-domain adalah code smell.

- **AppModule adalah composition root** — hanya import module lain, tidak punya controller/provider sendiri (kecuali kalau ada HealthController yang spesifik di-host di sana).

### Folder structure rekomendasi

src/\
├── modules/\
│ ├── users/\
│ │ ├── dto/\
│ │ │ ├── create-user.dto.ts \# input DTO (zod schema + class wrapper)\
│ │ │ └── user-response.dto.ts \# output DTO (serialisasi)\
│ │ ├── users.controller.ts \# @Controller — HTTP layer\
│ │ ├── users.service.ts \# @Injectable — business logic\
│ │ ├── users.repository.ts \# @Injectable — data access via Drizzle\
│ │ ├── users.module.ts \# @Module — wiring\
│ │ └── users.service.spec.ts \# unit test bersebelahan\
│ ├── orders/\
│ │ └── ... (struktur sama)\
│ └── billing/\
│ └── ... (struktur sama)\
├── common/\
│ ├── decorators/ \# @CurrentUser, @Public, dll\
│ ├── filters/ \# exception filter global\
│ ├── guards/ \# JwtAuthGuard, RolesGuard\
│ ├── interceptors/ \# LoggingInterceptor, TransformInterceptor\
│ ├── pipes/ \# ZodValidationPipe\
│ └── hooks/ \# Fastify hooks (request-id, dll)\
├── config/\
│ ├── env.schema.ts \# zod schema untuk env\
│ └── configuration.ts \# typed config object\
├── infrastructure/\
│ ├── database/\
│ │ ├── schema/ \# Drizzle pgTable schema\
│ │ │ ├── users.schema.ts\
│ │ │ ├── orders.schema.ts\
│ │ │ └── index.ts \# re-export semua schema\
│ │ ├── drizzle.service.ts \# wrapper koneksi\
│ │ └── drizzle.module.ts \# @Global module\
│ ├── redis/\
│ │ ├── redis.service.ts\
│ │ └── redis.module.ts\
│ ├── queue/\
│ │ └── queue.module.ts \# BullMQ root config\
│ └── logger/\
│ └── logger.module.ts \# nestjs-pino config\
├── app.module.ts \# composition root\
└── main.ts \# bootstrap (Fastify adapter)

Catatan: di project kecil-menengah, gabungkan dto/, users.controller.ts, dst di satu folder seperti di atas. Di project besar dengan domain kompleks, boleh tambah subfolder domain/ untuk value objects dan domain events. Jangan over-engineer di awal.

### Bootstrap dengan Fastify

*// src/main.ts*\
import { NestFactory } from '@nestjs/core'**;**\
import { FastifyAdapter**,** NestFastifyApplication } from '@nestjs/platform-fastify'**;**\
import { Logger } from 'nestjs-pino'**;**\
import helmet from '@fastify/helmet'**;**\
import compression from '@fastify/compress'**;**\
import { AppModule } from './app.module'**;**\
import { ConfigService } from '@nestjs/config'**;**\
import type { AppConfig } from './config/configuration'**;**\
\
**async** **function** **bootstrap**() {\
**const** app **=** **await** NestFactory**.create\<**NestFastifyApplication**\>**(\
AppModule**,**\
**new** **FastifyAdapter**({\
logger**:** **false,** *// logging di-handle nestjs-pino*\
trustProxy**:** **true,** *// di belakang ALB/ingress*\
bodyLimit**:** 1_048_576**,** *// 1 MB; naikkan eksplisit kalau perlu*\
genReqId**:** (req) **=\>** req**.**headers\['x-request-id'\]**?.toString**() **??** crypto**.randomUUID**()**,**\
})**,**\
{ bufferLogs**:** **true** }**,** *// tahan log sampai logger siap*\
)**;**\
\
app**.useLogger**(app**.get**(Logger))**;**\
\
**const** config **=** app**.get**(ConfigService**\<**AppConfig**,** **true\>**)**;**\
\
*// Plugin Fastify — register lewat HTTP adapter*\
**await** app**.register**(helmet**,** { contentSecurityPolicy**:** **false** })**;**\
**await** app**.register**(compression)**;**\
\
app**.enableCors**({\
origin**:** config**.get**('cors.origins'**,** { infer**:** **true** })**,**\
credentials**:** **true,**\
})**;**\
\
app**.enableShutdownHooks**()**;** *// wajib untuk graceful shutdown di K8s*\
\
**await** app**.listen**(config**.get**('port'**,** { infer**:** **true** })**,** '0.0.0.0')**;**\
}\
\
**void** **bootstrap**()**;**

Tiga hal yang sering terlewat: 1. '0.0.0.0' di listen() — tanpa ini container tidak terjangkau dari luar pod. 2. enableShutdownHooks() — tanpa ini SIGTERM dari Kubernetes tidak men-trigger OnModuleDestroy, koneksi DB dan worker BullMQ tidak ditutup bersih. 3. bufferLogs: true — tanpa ini log bootstrap pakai default Nest logger (text), bukan pino (JSON), dan susah di-grep di Loki.

### Module yang sehat

Module NestJS yang baik menyatakan dengan jelas: apa yang di-import, apa yang di-provide, apa yang di-export. Hindari module “kantong sampah” yang export semua provider-nya.

*// src/modules/users/users.module.ts*\
import { Module } from '@nestjs/common'**;**\
import { UsersController } from './users.controller'**;**\
import { UsersService } from './users.service'**;**\
import { UsersRepository } from './users.repository'**;**\
\
@**Module**({\
controllers**:** \[UsersController\]**,**\
providers**:** \[UsersService**,** UsersRepository\]**,**\
exports**:** \[UsersService\]**,** *// hanya UsersService yang dibutuhkan module lain.*\
*// UsersRepository adalah detail internal — jangan di-export.*\
})\
export **class** UsersModule {}

DrizzleModule di-mark @Global() (lihat di bawah) sehingga UsersRepository bisa inject DrizzleService tanpa harus di-import di setiap module.

### Konfigurasi dengan validasi schema

Aplikasi yang gagal startup karena config invalid jauh lebih baik dibanding aplikasi yang jalan tapi error 5 menit kemudian.

*// src/config/env.schema.ts*\
import { z } from 'zod'**;**\
\
export **const** envSchema **=** z**.object**({\
NODE_ENV**:** z**.enum**(\['development'**,** 'test'**,** 'production'\])**.default**('development')**,**\
PORT**:** z**.**coerce**.number**()**.int**()**.positive**()**.default**(3000)**,**\
\
DATABASE_URL**:** z**.string**()**.url**()**,**\
DATABASE_POOL_SIZE**:** z**.**coerce**.number**()**.int**()**.positive**()**.default**(20)**,**\
\
REDIS_URL**:** z**.string**()**.url**()**,**\
\
JWT_SECRET**:** z**.string**()**.min**(32)**,**\
JWT_EXPIRES_IN**:** z**.string**()**.default**('15m')**,**\
\
OTEL_EXPORTER_OTLP_ENDPOINT**:** z**.string**()**.url**()**.optional**()**,**\
LOG_LEVEL**:** z**.enum**(\['fatal'**,** 'error'**,** 'warn'**,** 'info'**,** 'debug'**,** 'trace'\])**.default**('info')**,**\
\
CORS_ORIGINS**:** z**.string**()**.transform**((s) **=\>** s**.split**(',')**.map**((o) **=\>** o**.trim**()))**,**\
})**;**\
\
export type Env **=** z**.**infer**\<typeof** envSchema**\>;**

*// src/config/configuration.ts*\
import { registerAs } from '@nestjs/config'**;**\
import { envSchema } from './env.schema'**;**\
\
export type AppConfig **=** ReturnType**\<typeof** appConfig**\>;**\
\
export **const** appConfig **=** **registerAs**('app'**,** () **=\>** {\
**const** env **=** envSchema**.parse**(process**.**env)**;** *// parse, jangan cuma cast — supaya nilai ter-coerce (number, array) sampai ke config object.*\
**return** {\
nodeEnv**:** env**.**NODE_ENV**,**\
port**:** env**.**PORT**,**\
database**:** { url**:** env**.**DATABASE_URL**,** poolSize**:** env**.**DATABASE_POOL_SIZE }**,**\
redis**:** { url**:** env**.**REDIS_URL }**,**\
jwt**:** { secret**:** env**.**JWT_SECRET**,** expiresIn**:** env**.**JWT_EXPIRES_IN }**,**\
cors**:** { origins**:** env**.**CORS_ORIGINS }**,**\
otel**:** { endpoint**:** env**.**OTEL_EXPORTER_OTLP_ENDPOINT }**,**\
logLevel**:** env**.**LOG_LEVEL**,**\
} as **const;**\
})**;**

*// src/app.module.ts (potongan)*\
import { ConfigModule } from '@nestjs/config'**;**\
import { envSchema } from './config/env.schema'**;**\
import { appConfig } from './config/configuration'**;**\
\
@**Module**({\
imports**:** \[\
ConfigModule**.forRoot**({\
isGlobal**:** **true,**\
load**:** \[appConfig\]**,**\
validate**:** (raw) **=\>** envSchema**.parse**(raw)**,** *// gagal startup kalau invalid*\
})**,**\
*// ... module lain*\
\]**,**\
})\
export **class** AppModule {}

### Global module untuk infrastructure

Module infrastructure yang dipakai hampir di semua tempat (Database, Logger, Cache) layak di-mark @Global(). Module business-domain **tidak**.

*// src/infrastructure/database/drizzle.module.ts*\
import { Global**,** Module } from '@nestjs/common'**;**\
import { DrizzleService } from './drizzle.service'**;**\
\
@**Global**()\
@**Module**({\
providers**:** \[DrizzleService\]**,**\
exports**:** \[DrizzleService\]**,**\
})\
export **class** DrizzleModule {}

### Anti-pattern

- **Module berdasarkan tipe (ControllersModule, ServicesModule).** Memecah kohesi domain. Module harus by bounded context.

- **AppModule punya provider/controller bisnis.** AppModule adalah composition root — kalau ada logic di sana, dia harus pindah ke module sendiri.

- **forwardRef() dipakai untuk “menyelesaikan” circular dependency tanpa refactor.** Tambal yang menyembunyikan masalah arsitektur. Hampir selalu yang benar adalah ekstrak shared concept ke module ketiga.

- **@Global() di module business.** Bikin dependency graph tidak jelas. Reviewer tidak bisa tahu apa yang di-import dari mana.

- **Repository di-skip — service inject DrizzleService langsung.** Kelihatannya hemat code, tapi unit test langsung butuh DB nyata, dan ganti ORM jadi proyek besar.

- **Logic bisnis di controller.** Controller tidak boleh tahu apapun selain HTTP. Kalau Anda nulis if (user.role === 'admin') di controller, itu di service.

- **ConfigService.get('foo') tanpa generic atau getOrThrow.** Return type jadi any \| undefined, type safety hilang. Pakai getOrThrow atau get\<T\>('foo', { infer: true }).

### Definition of Done — Pilar 1

- [ ] Setiap module mewakili satu bounded context, bukan satu tipe artefak.

- [ ] AppModule tidak punya controller/provider bisnis — hanya komposisi.

- [ ] Tidak ada forwardRef(), atau kalau ada, ada komentar yang menjelaskan kenapa belum di-refactor.

- [ ] Konfigurasi env divalidasi pakai zod di startup; aplikasi crash saat config invalid.

- [ ] main.ts pakai NestFastifyApplication + FastifyAdapter dengan trustProxy, genReqId, dan enableShutdownHooks().

- [ ] Repository class di-inject ke service; service tidak import Drizzle/db langsung.

- [ ] Module hanya export apa yang module lain butuhkan, bukan semua provider-nya.

- [ ] Tidak ada @Global() di module business-domain.

## Pilar 2 — API Design

### Prinsip

API adalah **kontrak**. Konsumen (frontend, partner, mobile) mengandalkan stabilitas kontrak; kalau Anda mengubahnya tanpa versioning, Anda mematahkan mereka. Validasi dilakukan **di boundary**, bukan di tengah service. Error berbentuk konsisten — RFC 7807 (Problem Details) atau format internal yang seragam — bukan campur antara {message: ...} dan {error: ...}.

Fastify menambahkan dua hal yang Express tidak punya: **JSON schema-based serialization** (lebih cepat, lebih ketat) dan **hooks lifecycle** (onRequest, preHandler, onResponse). Pakai NestJS pipe/guard/interceptor sebagai abstraksi utama; turun ke Fastify hooks hanya untuk concern yang murni HTTP-level (request-id, performance metric per-request).

### Aturan praktis

- **Versioning di URI** (/api/v1/users). Bukan di header (sulit di-cache, sulit di-test). Pakai NestJS VersioningType.URI — jangan tulis prefix manual di tiap controller.

- **Validasi pakai zod via nestjs-zod**. DTO = zod schema. Tidak ada validasi manual di service.

- **Pagination cursor-based untuk list yang bisa besar** (?cursor=...&limit=50). Offset-based cuma boleh untuk list kecil-tetap (kategori, role, dsb).

- **HTTP status code yang tepat**: 200 untuk success+data, 201 untuk created, 204 untuk no-content, 400 untuk validation error (client salah), 401 untuk unauthenticated, 403 untuk authenticated tapi tidak boleh, 404 untuk not found, 409 untuk conflict (idempotency, unique violation), 422 hanya kalau Anda secara konsisten membedakan “syntax invalid” (400) dari “semantically invalid” (422) — pilih satu konvensi.

- **Error format konsisten** (RFC 7807 application/problem+json). Filter exception global yang convert semua HttpException ke format ini.

- **Response shape stabil**. Jangan kirim full Drizzle row — pakai response DTO. Field yang tidak di-DTO harus tidak bocor.

- **Rate limit di edge** (ALB/ingress) untuk DDoS, **rate limit di app** untuk policy bisnis (@nestjs/throttler dengan Redis storage agar konsisten antar instance).

- **OpenAPI/Swagger di-generate, bukan ditulis tangan**. Schema zod + nestjs-zod/dto → swagger. Spec out-of-sync dengan code adalah bug yang menunggu produksi.

- **Idempotency-Key header untuk request yang side-effect-ful** (POST yang create resource pengaruh keuangan). Pakai Redis sebagai store dengan TTL.

### DTO dengan zod

*// src/modules/users/dto/create-user.dto.ts*\
import { createZodDto } from 'nestjs-zod'**;**\
import { z } from 'zod'**;**\
\
export **const** CreateUserSchema **=** z**.object**({\
email**:** z**.string**()**.email**()**.max**(255)**,**\
fullName**:** z**.string**()**.min**(1)**.max**(120)**,**\
password**:** z**.string**()**.min**(12)**.max**(128)**,**\
role**:** z**.enum**(\['admin'**,** 'staff'**,** 'customer'\])**.default**('customer')**,**\
})**.strict**()**;** *// strict() menolak field tak dikenal — penting*\
\
export **class** CreateUserDto **extends** **createZodDto**(CreateUserSchema) {}\
export type CreateUserInput **=** z**.**infer**\<typeof** CreateUserSchema**\>;**

*// src/modules/users/dto/user-response.dto.ts*\
import { createZodDto } from 'nestjs-zod'**;**\
import { z } from 'zod'**;**\
\
export **const** UserResponseSchema **=** z**.object**({\
id**:** z**.string**()**.uuid**()**,**\
email**:** z**.string**()**.email**()**,**\
fullName**:** z**.string**()**,**\
role**:** z**.enum**(\['admin'**,** 'staff'**,** 'customer'\])**,**\
createdAt**:** z**.string**()**.datetime**()**,**\
})**;**\
\
export **class** UserResponseDto **extends** **createZodDto**(UserResponseSchema) {}\
export type UserResponse **=** z**.**infer**\<typeof** UserResponseSchema**\>;**

Register ZodValidationPipe global, sekali di AppModule:

*// src/app.module.ts (potongan)*\
import { APP_PIPE } from '@nestjs/core'**;**\
import { ZodValidationPipe } from 'nestjs-zod'**;**\
\
@**Module**({\
providers**:** \[\
{ provide**:** APP_PIPE**,** useClass**:** ZodValidationPipe }**,**\
\]**,**\
})\
export **class** AppModule {}

### Controller yang tipis

*// src/modules/users/users.controller.ts*\
import { Body**,** Controller**,** Get**,** Param**,** Post**,** HttpCode**,** HttpStatus } from '@nestjs/common'**;**\
import { ApiTags } from '@nestjs/swagger'**;**\
import { ZodSerializerDto } from 'nestjs-zod'**;**\
import { UsersService } from './users.service'**;**\
import { CreateUserDto } from './dto/create-user.dto'**;**\
import { UserResponseDto } from './dto/user-response.dto'**;**\
\
@**ApiTags**('users')\
@**Controller**({ path**:** 'users'**,** version**:** '1' })\
export **class** UsersController {\
**constructor**(**private** **readonly** users**:** UsersService) {}\
\
@**Post**()\
@**HttpCode**(HttpStatus**.**CREATED)\
@**ZodSerializerDto**(UserResponseDto)\
**create**(@**Body**() body**:** CreateUserDto)**:** Promise**\<**UserResponseDto**\>** {\
**return** **this.**users**.create**(body)**;**\
}\
\
@**Get**(':id')\
@**ZodSerializerDto**(UserResponseDto)\
**findOne**(@**Param**('id') id**:** string)**:** Promise**\<**UserResponseDto**\>** {\
**return** **this.**users**.findById**(id)**;**\
}\
}

@ZodSerializerDto(...) memastikan response **di-strip** ke shape DTO. Field yang tidak di-DTO tidak bocor — ini garis pertahanan terakhir terhadap leak data sensitif (password hash, token).

### Custom decorator @CurrentUser

*// src/common/decorators/current-user.decorator.ts*\
import { createParamDecorator**,** ExecutionContext } from '@nestjs/common'**;**\
import type { FastifyRequest } from 'fastify'**;**\
\
export **interface** AuthUser {\
id**:** string**;**\
email**:** string**;**\
role**:** 'admin' **\|** 'staff' **\|** 'customer'**;**\
}\
\
export **const** CurrentUser **=** **createParamDecorator**(\
(\_data**:** unknown**,** ctx**:** ExecutionContext)**:** AuthUser **=\>** {\
**const** req **=** ctx**.switchToHttp**()**.getRequest\<**FastifyRequest **&** { user**:** AuthUser }**\>**()**;**\
**return** req**.**user**;**\
}**,**\
)**;**

Catatan: getRequest\<FastifyRequest\>() — pakai type Fastify, bukan Express Request. Property req.user di-set oleh JwtAuthGuard (lihat Pilar 4).

### Exception filter global (RFC 7807)

*// src/common/filters/all-exceptions.filter.ts*\
import {\
ArgumentsHost**,** Catch**,** ExceptionFilter**,** HttpException**,** HttpStatus**,** Logger**,**\
} from '@nestjs/common'**;**\
import type { FastifyReply**,** FastifyRequest } from 'fastify'**;**\
import { ZodError } from 'zod'**;**\
\
**interface** ProblemDetails {\
type**:** string**;**\
title**:** string**;**\
status**:** number**;**\
detail**?:** string**;**\
instance**:** string**;**\
errors**?:** unknown**;**\
requestId**:** string**;**\
}\
\
@**Catch**()\
export **class** AllExceptionsFilter **implements** ExceptionFilter {\
**private** **readonly** logger **=** **new** **Logger**(AllExceptionsFilter**.**name)**;**\
\
**catch**(exception**:** unknown**,** host**:** ArgumentsHost)**:** void {\
**const** ctx **=** host**.switchToHttp**()**;**\
**const** reply **=** ctx**.getResponse\<**FastifyReply**\>**()**;**\
**const** req **=** ctx**.getRequest\<**FastifyRequest**\>**()**;**\
\
**let** status **=** HttpStatus**.**INTERNAL_SERVER_ERROR**;**\
**let** title **=** 'Internal Server Error'**;**\
**let** detail**:** string **\|** undefined**;**\
**let** errors**:** unknown**;**\
\
**if** (exception **instanceof** ZodError) {\
status **=** HttpStatus**.**BAD_REQUEST**;**\
title **=** 'Validation Failed'**;**\
errors **=** exception**.flatten**()**;**\
} **else** **if** (exception **instanceof** HttpException) {\
status **=** exception**.getStatus**()**;**\
**const** res **=** exception**.getResponse**()**;**\
title **=** exception**.**message**;**\
detail **=** **typeof** res **===** 'object' **&&** res **&&** 'detail' **in** res\
**?** String((res as Record**\<**string**,** unknown**\>**)**.**detail) **:** undefined**;**\
} **else** **if** (exception **instanceof** Error) {\
**this.**logger**.error**({ err**:** exception }**,** 'unhandled exception')**;**\
detail **=** req**.**url**;** *// jangan expose stack ke client*\
}\
\
**const** body**:** ProblemDetails **=** {\
type**:** \`https://errors.example.com/**\${**status**}**\`**,**\
title**,**\
status**,**\
detail**,**\
instance**:** req**.**url**,**\
errors**,**\
requestId**:** req**.**id**,**\
}**;**\
\
reply**.status**(status)**.type**('application/problem+json')**.send**(body)**;**\
}\
}

Register global di main.ts:

*// src/main.ts (potongan)*\
app**.useGlobalFilters**(**new** **AllExceptionsFilter**())**;**

### Interceptor untuk cross-cutting concern

Logging request, transformasi response, audit. Di Fastify, prefer NestJS interceptor di atas Fastify hook — kecuali untuk concern yang harus jalan sebelum controller pipeline (request-id assignment).

*// src/common/interceptors/logging.interceptor.ts*\
import { CallHandler**,** ExecutionContext**,** Injectable**,** NestInterceptor } from '@nestjs/common'**;**\
import { PinoLogger } from 'nestjs-pino'**;**\
import { Observable**,** tap } from 'rxjs'**;**\
import type { FastifyRequest**,** FastifyReply } from 'fastify'**;**\
\
@**Injectable**()\
export **class** LoggingInterceptor **implements** NestInterceptor {\
**constructor**(**private** **readonly** logger**:** PinoLogger) {\
**this.**logger**.setContext**('HTTP')**;**\
}\
\
**intercept**(ctx**:** ExecutionContext**,** next**:** CallHandler)**:** Observable**\<**unknown**\>** {\
**const** req **=** ctx**.switchToHttp**()**.getRequest\<**FastifyRequest**\>**()**;**\
**const** reply **=** ctx**.switchToHttp**()**.getResponse\<**FastifyReply**\>**()**;**\
**const** start **=** process**.hrtime.bigint**()**;**\
\
**return** next**.handle**()**.pipe**(\
**tap**({\
next**:** () **=\>** **this.logComplete**(req**,** reply**,** start)**,**\
error**:** (err) **=\>** **this.logComplete**(req**,** reply**,** start**,** err)**,**\
})**,**\
)**;**\
}\
\
**private** **logComplete**(req**:** FastifyRequest**,** reply**:** FastifyReply**,** start**:** bigint**,** err**?:** unknown) {\
**const** durMs **=** Number(process**.hrtime.bigint**() **-** start) **/** 1e6**;**\
**this.**logger**.info**(\
{ method**:** req**.**method**,** path**:** req**.**url**,** status**:** reply**.**statusCode**,** durMs**,** err }**,**\
'request completed'**,**\
)**;**\
}\
}

### Rate limiting

*// src/app.module.ts (potongan)*\
import { ThrottlerModule**,** ThrottlerGuard } from '@nestjs/throttler'**;**\
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis'**;**\
import { APP_GUARD } from '@nestjs/core'**;**\
\
@**Module**({\
imports**:** \[\
ThrottlerModule**.forRootAsync**({\
imports**:** \[RedisModule\]**,**\
inject**:** \[RedisService\]**,**\
useFactory**:** (redis**:** RedisService) **=\>** ({\
throttlers**:** \[{ ttl**:** 60_000**,** limit**:** 100 }\]**,** *// 100 req/menit*\
storage**:** **new** **ThrottlerStorageRedisService**(redis**.**client)**,**\
})**,**\
})**,**\
\]**,**\
providers**:** \[{ provide**:** APP_GUARD**,** useClass**:** ThrottlerGuard }\]**,**\
})\
export **class** AppModule {}

Storage Redis penting karena kalau in-memory, rate limit reset per instance — useless di K8s dengan banyak replica.

### Pagination cursor-based

*// src/common/pagination/cursor-pagination.dto.ts*\
import { z } from 'zod'**;**\
import { createZodDto } from 'nestjs-zod'**;**\
\
export **const** CursorQuerySchema **=** z**.object**({\
cursor**:** z**.string**()**.optional**()**,** *// opaque, base64-encoded*\
limit**:** z**.**coerce**.number**()**.int**()**.min**(1)**.max**(100)**.default**(50)**,**\
})**;**\
\
export **class** CursorQueryDto **extends** **createZodDto**(CursorQuerySchema) {}\
\
export **interface** CursorPage**\<**T**\>** {\
items**:** T\[\]**;**\
nextCursor**:** string **\|** null**;**\
}

Repository implementasi (pakai created_at + id sebagai composite cursor) ada di Pilar 3.

### Swagger / OpenAPI otomatis

*// src/main.ts (potongan)*\
import { DocumentBuilder**,** SwaggerModule } from '@nestjs/swagger'**;**\
import { patchNestJsSwagger } from 'nestjs-zod'**;**\
\
**patchNestJsSwagger**()**;** *// bikin swagger ngerti zod schema*\
\
**const** cfg **=** **new** **DocumentBuilder**()\
**.setTitle**('Orders Service API')\
**.setVersion**('1.0.0')\
**.addBearerAuth**()\
**.build**()**;**\
\
**const** doc **=** SwaggerModule**.createDocument**(app**,** cfg)**;**\
SwaggerModule**.setup**('docs'**,** app**,** doc)**;**

Hanya expose /docs di non-production, atau gate dengan basic auth.

### Anti-pattern

- **Validasi manual di service.** Service mengasumsikan input sudah valid. Validasi di boundary (pipe) sehingga service stay business-focused.

- **Return Drizzle row langsung dari controller.** Membocorkan field internal (password_hash, internal_id). Selalu mapping ke response DTO.

- **Versioning di header (Accept: application/vnd.api+json;v=2).** Sulit di-cache di CDN, sulit ditest dari curl, susah di-debug. URI versioning jauh lebih praktis.

- **Error response berbeda-beda format per endpoint.** Frontend jadi punya 5 cara handle error. Satu format, di-enforce via filter global.

- **Pagination offset (?page=N&pageSize=M) untuk list besar.** Performa drop di page tinggi (OFFSET 1_000_000), data inkonsisten saat ada insert. Pakai cursor.

- **Tidak punya rate limit, atau rate limit in-memory di multi-instance.** Yang pertama bahaya, yang kedua palsu — selalu Redis-backed.

- **@Res() reply: FastifyReply di handler.** Begitu Anda menyentuh reply object langsung, NestJS interceptor dan response serialization tidak jalan. Pakai return value, bukan reply.

### Definition of Done — Pilar 2

- [ ] Semua route di-version di URI (/v1/...).

- [ ] Semua input divalidasi di pipe (zod schema), tidak ada validasi manual di service.

- [ ] Semua response dibungkus DTO via @ZodSerializerDto. Tidak ada Drizzle row bocor.

- [ ] Error format mengikuti RFC 7807 di-enforce via global exception filter.

- [ ] Rate limiter aktif dengan storage Redis (bukan in-memory).

- [ ] Pagination cursor-based untuk list yang bisa tumbuh besar.

- [ ] Swagger di-generate dari kode, di-host hanya di non-prod (atau di-protect).

- [ ] Tidak ada @Res() di handler.

- [ ] Idempotency-Key di-handle untuk endpoint state-changing yang re-tryable.

## Pilar 3 — Database & Data Layer (Drizzle)

### Prinsip

Drizzle adalah **type-safe SQL builder**, bukan abstraksi yang menyembunyikan database. Itu kekuatan utamanya: query yang Anda tulis adalah SQL yang dijalankan, type-nya di-infer dari schema. Tidak ada “magic find” yang generate query mengejutkan.

Tiga prinsip yang harus di-internalize: 1. **Schema adalah single source of truth.** Type domain di-derive dari schema (\$inferSelect, \$inferInsert), bukan ditulis dua kali. 2. **Service tidak tahu tentang Drizzle.** Repository membungkus query; service menerima/return domain type. 3. **Migration adalah artifact, bukan side-effect.** drizzle-kit generate membuat file migrasi yang di-commit; di-apply lewat pipeline deploy, tidak pernah di runtime aplikasi (kecuali di test setup).

### Aturan praktis

- **Schema di src/infrastructure/database/schema/**, satu file per domain (users, orders, …), re-export semua dari index.ts.

- **Pakai pgTable + relations** untuk model relasi. Pakai \$inferSelect/\$inferInsert untuk type domain. Jangan duplikasi.

- **Pool koneksi via driver pg (node-postgres)**, bukan postgres-js. pg punya pool dewasa, integrasi instrumentation OpenTelemetry baik. Drizzle support keduanya.

- **DrizzleService membungkus pool dan client drizzle().** Repository inject DrizzleService, bukan db global.

- **Transaction selalu pakai db.transaction(async (tx) =\> …)**. Service yang butuh transaction terima tx opsional sebagai parameter, atau pakai AsyncLocalStorage pattern (lihat di bawah).

- **Tidak ada db.execute(sql\raw…\`)\` untuk query bisnis.** Itu escape hatch untuk fitur yang Drizzle belum dukung (window function eksotik, vendor-specific). Default: query builder.

- **Index yang dipakai di query produksi harus di-define di schema** (via index('...').on(...)) supaya migration tracking-nya lewat drizzle-kit.

- **Hindari N+1.** Pakai db.query.users.findMany({ with: { orders: true } }) (relational query API) atau eksplisit leftJoin. Audit dengan EXPLAIN di staging untuk endpoint hot.

- **Soft delete kalau perlu, hard delete kalau tidak.** Soft delete (deletedAt) adalah komitmen jangka panjang yang menambah WHERE deletedAt IS NULL di SEMUA query. Pertimbangkan baik-baik.

### Schema: single source of truth

*// src/infrastructure/database/schema/users.schema.ts*\
import { pgTable**,** uuid**,** varchar**,** timestamp**,** pgEnum**,** index } from 'drizzle-orm/pg-core'**;**\
import { relations } from 'drizzle-orm'**;**\
import { orders } from './orders.schema'**;**\
\
export **const** userRole **=** **pgEnum**('user_role'**,** \['admin'**,** 'staff'**,** 'customer'\])**;**\
\
export **const** users **=** **pgTable**(\
'users'**,**\
{\
id**:** **uuid**('id')**.primaryKey**()**.defaultRandom**()**,**\
email**:** **varchar**('email'**,** { length**:** 255 })**.notNull**()**.unique**()**,**\
fullName**:** **varchar**('full_name'**,** { length**:** 120 })**.notNull**()**,**\
passwordHash**:** **varchar**('password_hash'**,** { length**:** 255 })**.notNull**()**,**\
role**:** **userRole**('role')**.notNull**()**.default**('customer')**,**\
createdAt**:** **timestamp**('created_at'**,** { withTimezone**:** **true** })**.notNull**()**.defaultNow**()**,**\
updatedAt**:** **timestamp**('updated_at'**,** { withTimezone**:** **true** })**.notNull**()**.defaultNow**()**,**\
deletedAt**:** **timestamp**('deleted_at'**,** { withTimezone**:** **true** })**,**\
}**,**\
(t) **=\>** ({\
createdAtIdx**:** **index**('users_created_at_idx')**.on**(t**.**createdAt)**,**\
emailIdx**:** **index**('users_email_idx')**.on**(t**.**email)**,**\
})**,**\
)**;**\
\
export **const** usersRelations **=** **relations**(users**,** ({ many }) **=\>** ({\
orders**:** **many**(orders)**,**\
}))**;**\
\
*// Type domain di-derive — JANGAN ditulis ulang.*\
export type User **=** **typeof** users**.**\$inferSelect**;**\
export type NewUser **=** **typeof** users**.**\$inferInsert**;**

*// src/infrastructure/database/schema/index.ts*\
export **\*** from './users.schema'**;**\
export **\*** from './orders.schema'**;**\
*// ... tambahkan saat ada schema baru*

### DrizzleService (wrapper koneksi)

*// src/infrastructure/database/drizzle.service.ts*\
import { Injectable**,** OnModuleInit**,** OnModuleDestroy**,** Logger } from '@nestjs/common'**;**\
import { ConfigService } from '@nestjs/config'**;**\
import { drizzle**,** NodePgDatabase } from 'drizzle-orm/node-postgres'**;**\
import { Pool } from 'pg'**;**\
import **\*** as schema from './schema'**;**\
import type { AppConfig } from '../../config/configuration'**;**\
\
export type Db **=** NodePgDatabase**\<typeof** schema**\>;**\
\
@**Injectable**()\
export **class** DrizzleService **implements** OnModuleInit**,** OnModuleDestroy {\
**private** **readonly** logger **=** **new** **Logger**(DrizzleService**.**name)**;**\
**private** pool**!:** Pool**;**\
**public** db**!:** Db**;**\
\
**constructor**(**private** **readonly** config**:** ConfigService**\<**AppConfig**,** **true\>**) {}\
\
**async** **onModuleInit**()**:** Promise**\<**void**\>** {\
**this.**pool **=** **new** **Pool**({\
connectionString**:** **this.**config**.get**('database.url'**,** { infer**:** **true** })**,**\
max**:** **this.**config**.get**('database.poolSize'**,** { infer**:** **true** })**,**\
idleTimeoutMillis**:** 30_000**,**\
connectionTimeoutMillis**:** 5_000**,**\
})**;**\
\
*// Verifikasi koneksi di startup — gagal cepat kalau DB tidak ready*\
**await** **this.**pool**.query**('select 1')**;**\
\
**this.**db **=** **drizzle**(**this.**pool**,** { schema**,** logger**:** **false** })**;**\
**this.**logger**.log**('database pool initialized')**;**\
}\
\
**async** **onModuleDestroy**()**:** Promise**\<**void**\>** {\
**await** **this.**pool**?.end**()**;**\
**this.**logger**.log**('database pool closed')**;**\
}\
}

Repository dapat DrizzleService.db lewat injection (lihat di bawah). Db type di-export sehingga test bisa pakai type yang sama.

### Repository pattern di atas Drizzle

*// src/modules/users/users.repository.ts*\
import { Injectable**,** NotFoundException } from '@nestjs/common'**;**\
import { and**,** desc**,** eq**,** isNull**,** lt**,** or**,** sql } from 'drizzle-orm'**;**\
import { DrizzleService**,** Db } from '../../infrastructure/database/drizzle.service'**;**\
import { users**,** **type** User**,** **type** NewUser } from '../../infrastructure/database/schema'**;**\
import type { CursorPage } from '../../common/pagination/cursor-pagination.dto'**;**\
\
@**Injectable**()\
export **class** UsersRepository {\
**constructor**(**private** **readonly** drizzle**:** DrizzleService) {}\
\
**private** **get** **db**()**:** Db { **return** **this.**drizzle**.**db**;** }\
\
**async** **findById**(id**:** string)**:** Promise**\<**User **\|** null**\>** {\
**const** \[row\] **=** **await** **this.**db\
**.select**()\
**.from**(users)\
**.where**(**and**(**eq**(users**.**id**,** id)**,** **isNull**(users**.**deletedAt)))\
**.limit**(1)**;**\
**return** row **??** **null;**\
}\
\
**async** **findByEmail**(email**:** string)**:** Promise**\<**User **\|** null**\>** {\
**const** \[row\] **=** **await** **this.**db\
**.select**()\
**.from**(users)\
**.where**(**and**(**eq**(users**.**email**,** email)**,** **isNull**(users**.**deletedAt)))\
**.limit**(1)**;**\
**return** row **??** **null;**\
}\
\
**async** **create**(input**:** NewUser)**:** Promise**\<**User**\>** {\
**const** \[row\] **=** **await** **this.**db**.insert**(users)**.values**(input)**.returning**()**;**\
**return** row**;**\
}\
\
**async** **listPage**(cursor**:** string **\|** undefined**,** limit**:** number)**:** Promise**\<**CursorPage**\<**User**\>\>** {\
**const** decoded **=** cursor **?** **decodeCursor**(cursor) **:** null**;**\
\
**const** rows **=** **await** **this.**db\
**.select**()\
**.from**(users)\
**.where**(\
**and**(\
**isNull**(users**.**deletedAt)**,**\
decoded\
**?** **or**(\
**lt**(users**.**createdAt**,** decoded**.**createdAt)**,**\
**and**(**eq**(users**.**createdAt**,** decoded**.**createdAt)**,** **lt**(users**.**id**,** decoded**.**id))**,**\
)\
**:** undefined**,**\
)**,**\
)\
**.orderBy**(**desc**(users**.**createdAt)**,** **desc**(users**.**id))\
**.limit**(limit **+** 1)**;**\
\
**const** items **=** rows**.slice**(0**,** limit)**;**\
**const** next **=** rows**.**length **\>** limit **?** **encodeCursor**(items\[items**.**length **-** 1\]) **:** null**;**\
**return** { items**,** nextCursor**:** next }**;**\
}\
\
**async** **softDelete**(id**:** string)**:** Promise**\<**void**\>** {\
**const** res **=** **await** **this.**db\
**.update**(users)\
**.set**({ deletedAt**:** **sql**\`now()\` })\
**.where**(**and**(**eq**(users**.**id**,** id)**,** **isNull**(users**.**deletedAt)))**;**\
**if** (res**.**rowCount **===** 0) **throw** **new** **NotFoundException**('user not found')**;**\
}\
}\
\
**function** **encodeCursor**(u**:** Pick**\<**User**,** 'id' **\|** 'createdAt'**\>**)**:** string {\
**return** Buffer**.from**(JSON**.stringify**({ id**:** u**.**id**,** createdAt**:** u**.**createdAt**.toISOString**() }))**.toString**('base64url')**;**\
}\
**function** **decodeCursor**(s**:** string)**:** { id**:** string**;** createdAt**:** Date } {\
**const** { id**,** createdAt } **=** JSON**.parse**(Buffer**.from**(s**,** 'base64url')**.toString**('utf8'))**;**\
**return** { id**,** createdAt**:** **new** Date(createdAt) }**;**\
}

Catatan: kunci cursor adalah (createdAt, id) — tidak boleh hanya createdAt karena tabrakan (dua user dibuat di milidetik sama). Index (created_at desc, id desc) di-define di schema.

### Transaction

Tiga skenario, tiga pendekatan:

**Sederhana — semua query ada di satu method.**

**async** **transferCredit**(fromId**:** string**,** toId**:** string**,** amount**:** number)**:** Promise**\<**void**\>** {\
**await** **this.**db**.transaction**(**async** (tx) **=\>** {\
**await** tx**.update**(accounts)**.set**({ balance**:** **sql**\`**\${**accounts**.**balance**}** - **\${**amount**}**\` })**.where**(**eq**(accounts**.**id**,** fromId))**;**\
**await** tx**.update**(accounts)**.set**({ balance**:** **sql**\`**\${**accounts**.**balance**}** + **\${**amount**}**\` })**.where**(**eq**(accounts**.**id**,** toId))**;**\
})**;**\
}

**Cross-repository — tx dipropagasi sebagai parameter opsional.**

*// repository*\
**async** **create**(input**:** NewOrder**,** tx**?:** Db)**:** Promise**\<**Order**\>** {\
**const** exec **=** tx **??** **this.**drizzle**.**db**;**\
**const** \[row\] **=** **await** exec**.insert**(orders)**.values**(input)**.returning**()**;**\
**return** row**;**\
}\
\
*// service*\
**async** **checkout**(userId**:** string**,** items**:** CartItem\[\]) {\
**return** **this.**drizzle**.**db**.transaction**(**async** (tx) **=\>** {\
**const** order **=** **await** **this.**ordersRepo**.create**({ userId**,** **...** }**,** tx)**;**\
**await** **this.**itemsRepo**.bulkCreate**(items**.map**((i) **=\>** ({ **...**i**,** orderId**:** order**.**id }))**,** tx)**;**\
**await** **this.**eventsRepo**.append**({ type**:** 'order.placed'**,** orderId**:** order**.**id }**,** tx)**;**\
**return** order**;**\
})**;**\
}

**Pattern lebih advanced — AsyncLocalStorage untuk transparan.** Berguna kalau Anda punya banyak repository dan tidak mau pass tx di mana-mana. Trade-off: implisit, butuh middleware/interceptor untuk set context. Pertimbangkan hanya kalau pendekatan eksplisit menjadi noisy.

### Caching dengan Redis

*// src/modules/users/users.service.ts (potongan)*\
import { Inject**,** Injectable } from '@nestjs/common'**;**\
import { CACHE_MANAGER } from '@nestjs/cache-manager'**;**\
import type { Cache } from 'cache-manager'**;**\
\
@**Injectable**()\
export **class** UsersService {\
**constructor**(\
**private** **readonly** repo**:** UsersRepository**,**\
@**Inject**(CACHE_MANAGER) **private** **readonly** cache**:** Cache**,**\
) {}\
\
**async** **findById**(id**:** string) {\
**const** key **=** \`user:**\${**id**}**\`**;**\
**const** cached **=** **await** **this.**cache**.get\<**User**\>**(key)**;**\
**if** (cached) **return** cached**;**\
**const** user **=** **await** **this.**repo**.findById**(id)**;**\
**if** (user) **await** **this.**cache**.set**(key**,** user**,** 60_000)**;** *// 60 detik*\
**return** user**;**\
}\
\
**async** **update**(id**:** string**,** patch**:** Partial**\<**NewUser**\>**) {\
**const** updated **=** **await** **this.**repo**.update**(id**,** patch)**;**\
**await** **this.**cache**.del**(\`user:**\${**id**}**\`)**;** *// invalidate*\
**return** updated**;**\
}\
}

Aturan caching: - **TTL pendek (10–120 detik)** untuk read yang sering tapi data tidak super dinamis. Lebih panjang hanya kalau ada strategi invalidasi yang jelas. - **Invalidate on write** atau pakai cache-aside (set saat read, hapus saat write). - **Jangan cache data per-user dengan key generik.** Selalu include user-id atau scope di key. - **Cache stampede protection** — kalau hot key, pakai cache.wrap() atau implementasi lock.

### Hindari N+1

*// ❌ N+1: fetch user lalu loop fetch orders per user*\
**const** usersList **=** **await** **this.**db**.select**()**.from**(users)**.limit**(20)**;**\
**for** (**const** u **of** usersList) {\
**const** orders **=** **await** **this.**db**.select**()**.from**(orders)**.where**(**eq**(orders**.**userId**,** u**.**id))**;**\
*// ...*\
}\
\
*// ✅ Relational query — satu round-trip*\
**const** result **=** **await** **this.**db**.**query**.**users**.findMany**({\
**with:** { orders**:** { limit**:** 5 } }**,**\
limit**:** 20**,**\
})**;**\
\
*// ✅ Atau eksplisit join + agregasi di memory*\
**const** rows **=** **await** **this.**db\
**.select**()\
**.from**(users)\
**.leftJoin**(orders**,** **eq**(orders**.**userId**,** users**.**id))\
**.limit**(100)**;**

Untuk endpoint hot (homepage, list utama), wajib jalankan EXPLAIN ANALYZE di staging. Plan node “Nested Loop” ratusan iterasi adalah red flag.

### Migrations dengan drizzle-kit

Konvensi tim: - Source of truth: src/infrastructure/database/schema/\*.ts. - Output migrasi: drizzle/ (di-commit). - Generate: pnpm drizzle-kit generate setelah ubah schema. - Apply: pnpm drizzle-kit migrate di pipeline deploy (bukan di app startup, kecuali test).

Detail strategi (zero-downtime, expand-contract, rollback) ada di **Pilar 8 — Migrations Strategy**.

### Anti-pattern

- **Service inject DrizzleService langsung dan pakai db.select(...) sendiri.** Bocor abstraksi. Repository jadi optional, dan unit test perlu DB nyata.

- **Type domain ditulis ulang** sebagai interface manual padahal schema sudah ada. Bug: ketika schema berubah, type lupa di-update, runtime divergent.

- \*\*db.execute(sql\select …\`)sebagai default.\*\* Kehilangan type safety. Pakai query builder;sql\`\`hanya untuk fragment khusus dalam query builder (mis. diwhere\`).

- **Transaction dibuka di repository (this.db.transaction(...)) padahal scope-nya cross-repository.** Repository tidak boleh memutuskan boundary transaksi — itu tugas service.

- **Migration di-apply di onApplicationBootstrap.** Bekerja di dev, hancur di multi-instance K8s (race condition siapa apply duluan). Migration di pipeline.

- **Tidak ada WHERE deletedAt IS NULL** di query setelah memutuskan pakai soft-delete. Konsumen melihat user/order yang sudah dihapus.

- **Index tidak di-define di schema** — drizzle-kit tidak tahu, di staging cepat (data kecil) tapi di prod meledak.

### Definition of Done — Pilar 3

- [ ] Schema di-define dengan pgTable, type domain di-derive via \$inferSelect/\$inferInsert.

- [ ] Service tidak meng-import drizzle atau db — semua via repository.

- [ ] Transaction yang cross-repository di-orchestrate di service, dengan tx dipropagasi ke repository.

- [ ] Index untuk semua query yang dipakai di endpoint hot di-define di schema.

- [ ] Tidak ada db.execute(raw sql) untuk query bisnis. Kalau ada, ada justifikasi tertulis.

- [ ] Pagination cursor-based, bukan offset, untuk list yang bisa tumbuh besar.

- [ ] N+1 di-audit lewat EXPLAIN ANALYZE untuk endpoint utama.

- [ ] Migration generated lewat drizzle-kit, di-commit, di-apply di pipeline.

## Pilar 4 — Security

### Prinsip

Security bukan satu pilar — security adalah **disiplin** yang mempengaruhi setiap pilar lain. Tapi ada beberapa konvensi yang spesifik dan testable, yang harus konsisten lintas service. Default ke **deny**: setiap endpoint perlu auth, kecuali eksplisit di-mark @Public(). Setiap input divalidasi di pipe. Setiap query parameterized (Drizzle melakukan ini by default — jangan rusak dengan sql\\\` yang interpolasi user input).

### Aturan praktis

- **JWT untuk auth API**, dengan TTL pendek (15 menit) dan refresh token terpisah dengan TTL panjang (7 hari) di store rotating (Redis).

- **Default JwtAuthGuard global**, opt-out dengan @Public() decorator. Jangan kebalikan — terlalu mudah lupa proteksi endpoint baru.

- **RBAC via RolesGuard** untuk role coarse-grained. Untuk authorization fine-grained (resource ownership), check di service, bukan guard.

- **Password hash dengan argon2id** (parameter sesuai OWASP terbaru), bukan bcrypt. argon2 library: argon2.

- **Helmet, CORS, rate-limit di-apply di main.ts** — bahkan kalau ALB sudah punya. Defense in depth.

- **Secret management via env + secret manager** (AWS Secrets Manager, GCP Secret Manager, atau Sealed Secrets di K8s). Tidak pernah di repo.

- **Audit log untuk operasi sensitif** (auth, role change, financial). Log ke logger biasa dengan tag audit: true dan property structured (actor, action, target, outcome).

- **OWASP Top 10 — internalized.** Lihat checklist di akhir pilar.

### JwtAuthGuard global + @Public escape

*// src/common/guards/jwt-auth.guard.ts*\
import { ExecutionContext**,** Injectable } from '@nestjs/common'**;**\
import { Reflector } from '@nestjs/core'**;**\
import { AuthGuard } from '@nestjs/passport'**;**\
import { IS_PUBLIC_KEY } from '../decorators/public.decorator'**;**\
\
@**Injectable**()\
export **class** JwtAuthGuard **extends** **AuthGuard**('jwt') {\
**constructor**(**private** **readonly** reflector**:** Reflector) { **super**()**;** }\
\
**canActivate**(context**:** ExecutionContext) {\
**const** isPublic **=** **this.**reflector**.getAllAndOverride\<**boolean**\>**(IS_PUBLIC_KEY**,** \[\
context**.getHandler**()**,** context**.getClass**()**,**\
\])**;**\
**if** (isPublic) **return** **true;**\
**return** **super.canActivate**(context)**;**\
}\
}

*// src/common/decorators/public.decorator.ts*\
import { SetMetadata } from '@nestjs/common'**;**\
export **const** IS_PUBLIC_KEY **=** 'isPublic'**;**\
export **const** Public **=** () **=\>** **SetMetadata**(IS_PUBLIC_KEY**,** **true**)**;**

Register global:

*// src/app.module.ts (potongan)*\
import { APP_GUARD } from '@nestjs/core'**;**\
import { JwtAuthGuard } from './common/guards/jwt-auth.guard'**;**\
\
providers**:** \[\
{ provide**:** APP_GUARD**,** useClass**:** JwtAuthGuard }**,**\
\]**,**

Pemakaian:

@**Controller**({ path**:** 'auth'**,** version**:** '1' })\
export **class** AuthController {\
@**Public**() *// login tidak butuh JWT*\
@**Post**('login')\
**login**(@**Body**() dto**:** LoginDto) { */\* ... \*/* }\
\
@**Get**('me') *// butuh JWT (default)*\
**me**(@**CurrentUser**() user**:** AuthUser) { **return** user**;** }\
}

### RolesGuard

*// src/common/guards/roles.guard.ts*\
import { CanActivate**,** ExecutionContext**,** Injectable**,** ForbiddenException**,** SetMetadata } from '@nestjs/common'**;**\
import { Reflector } from '@nestjs/core'**;**\
import type { FastifyRequest } from 'fastify'**;**\
import type { AuthUser } from '../decorators/current-user.decorator'**;**\
\
export **const** ROLES_KEY **=** 'roles'**;**\
export **const** Roles **=** (**...**roles**:** AuthUser\['role'\]\[\]) **=\>**\
**SetMetadata**(ROLES_KEY**,** roles)**;** *// pakai SetMetadata, konsisten dengan @Public; Reflect.metadata adalah factory style yang berbeda perilakunya.*\
\
@**Injectable**()\
export **class** RolesGuard **implements** CanActivate {\
**constructor**(**private** **readonly** reflector**:** Reflector) {}\
\
**canActivate**(ctx**:** ExecutionContext)**:** boolean {\
**const** required **=** **this.**reflector**.getAllAndOverride\<**AuthUser\['role'\]\[\]**\>**(\
ROLES_KEY**,** \[ctx**.getHandler**()**,** ctx**.getClass**()\]**,**\
)**;**\
**if** (**!**required**?.**length) **return** **true;**\
**const** req **=** ctx**.switchToHttp**()**.getRequest\<**FastifyRequest **&** { user**:** AuthUser }**\>**()**;**\
**if** (**!**required**.includes**(req**.**user**.**role)) {\
**throw** **new** **ForbiddenException**('insufficient role')**;**\
}\
**return** **true;**\
}\
}

@**Controller**({ path**:** 'admin'**,** version**:** '1' })\
@**UseGuards**(RolesGuard)\
export **class** AdminController {\
@**Roles**('admin')\
@**Get**('users')\
**list**() { */\* ... \*/* }\
}

### Resource ownership di service

RolesGuard tidak tahu konteks resource. “Customer hanya boleh lihat order miliknya” adalah authorization fine-grained — itu di service.

**async** **getOrder**(id**:** string**,** user**:** AuthUser)**:** Promise**\<**Order**\>** {\
**const** order **=** **await** **this.**repo**.findById**(id)**;**\
**if** (**!**order) **throw** **new** **NotFoundException**()**;**\
**if** (user**.**role **!==** 'admin' **&&** order**.**userId **!==** user**.**id) {\
**throw** **new** **ForbiddenException**('not your order')**;**\
}\
**return** order**;**\
}

### JwtStrategy

*// src/modules/auth/jwt.strategy.ts*\
import { Injectable**,** UnauthorizedException } from '@nestjs/common'**;**\
import { PassportStrategy } from '@nestjs/passport'**;**\
import { ConfigService } from '@nestjs/config'**;**\
import { ExtractJwt**,** Strategy } from 'passport-jwt'**;**\
import { UsersService } from '../users/users.service'**;**\
import type { AppConfig } from '../../config/configuration'**;**\
import type { AuthUser } from '../../common/decorators/current-user.decorator'**;**\
\
**interface** JwtPayload { sub**:** string**;** role**:** AuthUser\['role'\]**;** iat**:** number**;** exp**:** number**;** }\
\
@**Injectable**()\
export **class** JwtStrategy **extends** **PassportStrategy**(Strategy) {\
**constructor**(\
config**:** ConfigService**\<**AppConfig**,** **true\>,**\
**private** **readonly** users**:** UsersService**,**\
) {\
**super**({\
jwtFromRequest**:** ExtractJwt**.fromAuthHeaderAsBearerToken**()**,**\
secretOrKey**:** config**.get**('jwt.secret'**,** { infer**:** **true** })**,**\
ignoreExpiration**:** **false,**\
})**;**\
}\
\
**async** **validate**(payload**:** JwtPayload)**:** Promise**\<**AuthUser**\>** {\
**const** user **=** **await** **this.**users**.findById**(payload**.**sub)**;**\
**if** (**!**user **\|\|** user**.**deletedAt) **throw** **new** **UnauthorizedException**()**;**\
**return** { id**:** user**.**id**,** email**:** user**.**email**,** role**:** user**.**role }**;**\
}\
}

### Hash password (argon2id)

import **\*** as argon2 from 'argon2'**;**\
\
**const** hash **=** **await** argon2**.hash**(plain**,** {\
type**:** argon2**.**argon2id**,**\
memoryCost**:** 19_456**,** *// 19 MiB — OWASP minimum*\
timeCost**:** 2**,**\
parallelism**:** 1**,**\
})**;**\
\
**const** ok **=** **await** argon2**.verify**(hash**,** plain)**;**

Tuning: memoryCost/timeCost sebaiknya menghasilkan hash time ~250–500 ms di hardware target. Test ulang setiap pindah class instance.

### Helmet, CORS, rate-limit

Sudah dibahas di Pilar 1 (main.ts) dan Pilar 2 (rate-limit). Pastikan ketiganya **selalu aktif** di production — tidak ada if (env !== 'production') yang menonaktifkan.

### Audit logging

*// src/common/interceptors/audit.interceptor.ts*\
import { CallHandler**,** ExecutionContext**,** Injectable**,** NestInterceptor**,** SetMetadata } from '@nestjs/common'**;**\
import { Reflector } from '@nestjs/core'**;**\
import { PinoLogger } from 'nestjs-pino'**;**\
import { Observable**,** tap } from 'rxjs'**;**\
\
export **const** AUDIT_KEY **=** 'audit'**;**\
export **const** Audit **=** (action**:** string) **=\>** **SetMetadata**(AUDIT_KEY**,** action)**;**\
\
@**Injectable**()\
export **class** AuditInterceptor **implements** NestInterceptor {\
**constructor**(**private** **readonly** reflector**:** Reflector**,** **private** **readonly** logger**:** PinoLogger) {\
**this.**logger**.setContext**('audit')**;**\
}\
\
**intercept**(ctx**:** ExecutionContext**,** next**:** CallHandler)**:** Observable**\<**unknown**\>** {\
**const** action **=** **this.**reflector**.get\<**string**\>**(AUDIT_KEY**,** ctx**.getHandler**())**;**\
**if** (**!**action) **return** next**.handle**()**;**\
\
**const** req **=** ctx**.switchToHttp**()**.getRequest**()**;**\
**return** next**.handle**()**.pipe**(\
**tap**({\
next**:** () **=\>** **this.**logger**.info**({ audit**:** **true,** action**,** actor**:** req**.**user**?.**id**,** target**:** req**.**params**,** outcome**:** 'success' })**,**\
error**:** (err) **=\>** **this.**logger**.warn**({ audit**:** **true,** action**,** actor**:** req**.**user**?.**id**,** target**:** req**.**params**,** outcome**:** 'failure'**,** err**:** err**.**message })**,**\
})**,**\
)**;**\
}\
}

@**Audit**('user.role.change')\
@**Roles**('admin')\
@**Patch**(':id/role')\
**async** **changeRole**(**...**) { */\* ... \*/* }

### OWASP Top 10 — checklist NestJS+Fastify+Drizzle

| \# | Item | Bagaimana ditangani |
|----|----|----|
| A01 Broken Access Control | RBAC via guard + ownership check di service. Default deny (JwtAuthGuard global). |  |
| A02 Cryptographic Failures | TLS di edge. JWT signing dengan secret kuat (32+ char). Password argon2id. PII tidak di-log. |  |
| A03 Injection | Drizzle parameterized queries by default. Tidak ada string-concat di sql\\. zod validate input di pipe. \| \| A04 Insecure Design \| Threat modeling untuk fitur baru (terutama auth, payment). Idempotency-Key untuk operasi keuangan. \| \| A05 Security Misconfiguration \| Helmet aktif, CORS whitelist, secret di env, debug tidak di-leak ke client (filter eksposdetailsaja, bukan stack). \| \| A06 Vulnerable Components \| Dependency scan di CI (pnpm audit\`, Snyk, atau Dependabot). Lockfile di-commit. |  |
| A07 Identification & Auth Failures | Refresh token rotating, lockout setelah N failed login (Redis counter), 2FA untuk admin. |  |
| A08 Software & Data Integrity | Image Docker signed, supply chain via SLSA (kalau matur). Lockfile + integrity check di-enforce. |  |
| A09 Logging & Monitoring Failures | Structured log dengan request-id, audit log untuk operasi sensitif, alert di anomaly. |  |
| A10 SSRF | Outbound request hanya ke allowlist domain. URL dari user di-validate dengan zod (regex domain) sebelum fetch. |  |

### Anti-pattern

- **Endpoint baru tanpa JwtAuthGuard** karena lupa global tidak aktif. Pastikan global aktif sejak setup, tambah @Public() saat eksplisit.

- **Role check di controller pakai if.** Lupa di endpoint lain. Pakai RolesGuard + @Roles().

- **Resource ownership di guard yang tidak tahu domain.** Guard hanya untuk role coarse. Ownership di service.

- **Password di-hash dengan SHA-256/MD5.** Tidak adaptive. Pakai argon2id.

- **Stack trace ke client.** Filter exception harus sembunyikan internal di prod.

- **CORS \* dengan credentials: true.** Dilarang oleh spec, tapi sering dilakukan; akhirnya buka cross-origin attack. Whitelist eksplisit.

- **Secret di-log oleh interceptor logging.** Pastikan req.body.password, req.headers.authorization di-redact (pino redact).

### Definition of Done — Pilar 4

- [ ] JwtAuthGuard aktif global; semua endpoint butuh JWT kecuali @Public().

- [ ] RolesGuard di-apply untuk role coarse; ownership di-check di service untuk resource per-user.

- [ ] Password di-hash argon2id dengan parameter OWASP minimum.

- [ ] Helmet, CORS whitelist, rate-limit aktif di prod.

- [ ] Pino redact untuk header authorization, body password, token.

- [ ] Audit log untuk operasi sensitif (auth, role, financial).

- [ ] Filter exception tidak mengekspos stack trace ke client di prod.

- [ ] pnpm audit (atau Snyk) jalan di CI; vuln high/critical block PR.

## Pilar 5 — Testing (Vitest)

### Prinsip

Test bukan pajak — test adalah **dokumentasi yang dieksekusi** dan **safety net** saat refactor. Tiga lapisan, masing-masing dengan trade-off berbeda:

1.  **Unit test (banyak, cepat).** Service di-test dengan repository di-mock. Tujuan: verifikasi business logic. Tidak menyentuh DB, tidak menyentuh network.

2.  **Integration test (sedang, agak lambat).** Repository di-test dengan PostgreSQL nyata via Testcontainers. Tujuan: verifikasi query Drizzle, constraint, migration.

3.  **E2E test (sedikit, paling lambat).** App di-bootstrap penuh dengan Fastify; request via inject(). Tujuan: verifikasi wiring (guard, pipe, filter, interceptor) bekerja end-to-end.

Vitest dipilih atas Jest karena: ESM native, watch mode lebih cepat, kompatibilitas API hampir 1:1 dengan Jest. NestJS Test module bekerja sama persis.

### Aturan praktis

- **Vitest sebagai test runner.** Konfigurasi di vitest.config.ts. Test file co-located: users.service.spec.ts di samping users.service.ts.

- **Unit test 70%, integration 20%, E2E 10%** sebagai panduan kasar — bukan KPI. Sesuaikan dengan area risiko.

- **Coverage target: 80% lines untuk service & repository, 100% untuk util kritis** (auth, money math). Coverage tidak menggantikan test design — test yang asal cover adalah waste.

- **Test factory untuk fixture.** Hindari literal panjang yang berulang. Bikin makeUser({ role: 'admin' }).

- **Setiap bug-fix disertai regression test** yang gagal sebelum fix dan lulus sesudah.

- **Database test pakai Testcontainers**, bukan SQLite mock atau DB shared. Container fresh per test suite.

- **E2E pakai app.getHttpAdapter().getInstance().inject(...)** — Fastify inject lebih cepat dari supertest TCP, tapi supertest tetap kompatibel.

- **Override provider** untuk dependency yang sulit (waktu, randomness, external API): Test.createTestingModule({...}).overrideProvider(...).

- **Tidak boleh pakai imports: \[AppModule\] di test** kecuali e2e penuh. Module under test harus eksplisit — kalau perlu AppModule berarti test scope-nya salah.

### Setup Vitest

*// vitest.config.ts*\
import { defineConfig } from 'vitest/config'**;**\
import swc from 'unplugin-swc'**;**\
\
export default **defineConfig**({\
plugins**:** \[swc**.vite**({ module**:** { type**:** 'es6' } })\]**,**\
test**:** {\
globals**:** **true,**\
environment**:** 'node'**,**\
coverage**:** {\
provider**:** 'v8'**,**\
reporter**:** \['text'**,** 'lcov'\]**,**\
exclude**:** \['\*\*/\*.spec.ts'**,** '\*\*/main.ts'**,** '\*\*/\*.module.ts'**,** 'drizzle/\*\*'**,** 'dist/\*\*'\]**,**\
thresholds**:** { lines**:** 80**,** functions**:** 80**,** branches**:** 75**,** statements**:** 80 }**,**\
}**,**\
setupFiles**:** \['./test/setup.ts'\]**,**\
}**,**\
})**;**

*// test/setup.ts*\
import 'reflect-metadata'**;** *// wajib untuk decorator NestJS*

package.json:

**{**\
"scripts"**:** **{**\
"test"**:** "vitest run"**,**\
"test:watch"**:** "vitest"**,**\
"test:cov"**:** "vitest run --coverage"**,**\
"test:e2e"**:** "vitest run --config vitest.e2e.config.ts"\
**}**\
**}**

### Unit test service — minimal setup

*// src/modules/users/users.service.spec.ts*\
import { Test } from '@nestjs/testing'**;**\
import { describe**,** it**,** expect**,** beforeEach**,** vi } from 'vitest'**;**\
import { UsersService } from './users.service'**;**\
import { UsersRepository } from './users.repository'**;**\
import { CACHE_MANAGER } from '@nestjs/cache-manager'**;**\
\
**describe**('UsersService'**,** () **=\>** {\
**let** service**:** UsersService**;**\
**let** repo**:** { findById**:** ReturnType**\<typeof** vi**.**fn**\>;** create**:** ReturnType**\<typeof** vi**.**fn**\>** }**;**\
**let** cache**:** { **get:** ReturnType**\<typeof** vi**.**fn**\>;** **set:** ReturnType**\<typeof** vi**.**fn**\>;** del**:** ReturnType**\<typeof** vi**.**fn**\>** }**;**\
\
**beforeEach**(**async** () **=\>** {\
repo **=** { findById**:** vi**.fn**()**,** create**:** vi**.fn**() }**;**\
cache **=** { **get:** vi**.fn**()**,** **set:** vi**.fn**()**,** del**:** vi**.fn**() }**;**\
\
**const** module = await Test.createTestingModule({\
providers**:** \[\
UsersService**,**\
{ provide**:** UsersRepository**,** useValue**:** repo }**,**\
{ provide**:** CACHE_MANAGER**,** useValue**:** cache }**,**\
\]**,**\
})**.compile**()**;**\
\
service **=** module**.get**(UsersService)**;**\
})**;**\
\
**it**('returns cached user when present'**,** **async** () **=\>** {\
cache**.**get**.mockResolvedValue**({ id**:** '1'**,** email**:** 'a@b.com' })**;**\
**const** out **=** **await** service**.findById**('1')**;**\
**expect**(out)**.toEqual**({ id**:** '1'**,** email**:** 'a@b.com' })**;**\
**expect**(repo**.**findById)**.**not**.toHaveBeenCalled**()**;**\
})**;**\
\
**it**('falls back to repo and caches'**,** **async** () **=\>** {\
cache**.**get**.mockResolvedValue**(**null**)**;**\
repo**.**findById**.mockResolvedValue**({ id**:** '1'**,** email**:** 'a@b.com' })**;**\
**const** out **=** **await** service**.findById**('1')**;**\
**expect**(out**?.**id)**.toBe**('1')**;**\
**expect**(cache**.**set)**.toHaveBeenCalledWith**('user:1'**,** expect**.anything**()**,** 60_000)**;**\
})**;**\
})**;**

### Integration test repository dengan Testcontainers

*// src/modules/users/users.repository.int-spec.ts*\
import { describe**,** it**,** expect**,** beforeAll**,** afterAll } from 'vitest'**;**\
import { PostgreSqlContainer**,** StartedPostgreSqlContainer } from '@testcontainers/postgresql'**;**\
import { drizzle**,** NodePgDatabase } from 'drizzle-orm/node-postgres'**;**\
import { migrate } from 'drizzle-orm/node-postgres/migrator'**;**\
import { Pool } from 'pg'**;**\
import **\*** as schema from '../../infrastructure/database/schema'**;**\
import { UsersRepository } from './users.repository'**;**\
\
**describe**('UsersRepository (integration)'**,** () **=\>** {\
**let** container**:** StartedPostgreSqlContainer**;**\
**let** pool**:** Pool**;**\
**let** db**:** NodePgDatabase**\<typeof** schema**\>;**\
**let** repo**:** UsersRepository**;**\
\
**beforeAll**(**async** () **=\>** {\
container **=** **await** **new** **PostgreSqlContainer**('postgres:16-alpine')**.start**()**;**\
pool **=** **new** **Pool**({ connectionString**:** container**.getConnectionUri**() })**;**\
db **=** **drizzle**(pool**,** { schema })**;**\
**await** **migrate**(db**,** { migrationsFolder**:** 'drizzle' })**;**\
\
*// Bangun DrizzleService minimal yang punya kontrak sama dengan production.*\
*// Hindari `as never` — itu menyembunyikan drift kalau DrizzleService berubah.*\
**const** drizzleService**:** Pick**\<**DrizzleService**,** 'db'**\>** **=** { db }**;**\
repo **=** **new** **UsersRepository**(drizzleService as DrizzleService)**;**\
}**,** 60_000)**;**\
\
**afterAll**(**async** () **=\>** {\
**await** pool**.end**()**;**\
**await** container**.stop**()**;**\
})**;**\
\
**it**('creates and reads back'**,** **async** () **=\>** {\
**const** created **=** **await** repo**.create**({ email**:** 'a@b.com'**,** fullName**:** 'A B'**,** passwordHash**:** 'x' })**;**\
**const** got **=** **await** repo**.findByEmail**('a@b.com')**;**\
**expect**(got**?.**id)**.toBe**(created**.**id)**;**\
})**;**\
})**;**

Container start ~3–5 detik. Di CI, share container antar test suite dengan globalSetup kalau performa jadi masalah.

### E2E test dengan Fastify inject

*// test/e2e/users.e2e-spec.ts*\
import { Test } from '@nestjs/testing'**;**\
import { FastifyAdapter**,** NestFastifyApplication } from '@nestjs/platform-fastify'**;**\
import { ValidationPipe**,** INestApplication } from '@nestjs/common'**;**\
import { describe**,** it**,** expect**,** beforeAll**,** afterAll } from 'vitest'**;**\
import { AppModule } from '../../src/app.module'**;**\
\
**describe**('Users (e2e)'**,** () **=\>** {\
**let** app**:** NestFastifyApplication**;**\
\
**beforeAll**(**async** () **=\>** {\
**const** mod **=** **await** Test**.createTestingModule**({ imports**:** \[AppModule\] })\
**.overrideProvider**('SOME_TOKEN')**.useValue**(*/\* fake \*/*)\
**.compile**()**;**\
\
app **=** mod**.createNestApplication\<**NestFastifyApplication**\>**(**new** **FastifyAdapter**())**;**\
*// pipe/guard/filter global yang dipakai di main.ts juga harus di-pasang di sini*\
**await** app**.init**()**;**\
**await** app**.getHttpAdapter**()**.getInstance**()**.ready**()**;**\
})**;**\
\
**afterAll**(**async** () **=\>** { **await** app**.close**()**;** })**;**\
\
**it**('POST /v1/users → 201'**,** **async** () **=\>** {\
**const** res **=** **await** app**.inject**({\
method**:** 'POST'**,**\
url**:** '/v1/users'**,**\
payload**:** { email**:** 'x@y.com'**,** fullName**:** 'X'**,** password**:** 'Sup3rSafePassw0rd!' }**,**\
headers**:** { 'content-type'**:** 'application/json' }**,**\
})**;**\
**expect**(res**.**statusCode)**.toBe**(201)**;**\
**expect**(res**.json**())**.toMatchObject**({ email**:** 'x@y.com' })**;**\
})**;**\
})**;**

**Penting:** kalau e2e test pakai AppModule, semua wiring global di main.ts harus diulang manual (useGlobalPipes, useGlobalFilters, dll), atau pindahkan wiring itu ke AppModule provider (APP_PIPE, APP_FILTER) — yang lebih bersih.

### Override provider untuk dependency sulit

**const** mod **=** **await** Test**.createTestingModule**({ imports**:** \[AppModule\] })\
**.overrideProvider**(ClockService)\
**.useValue**({ now**:** () **=\>** **new** Date('2026-01-01T00:00:00Z') })\
**.overrideProvider**(EmailGateway)\
**.useValue**({ send**:** vi**.fn**()**.mockResolvedValue**({ messageId**:** 'fake' }) })\
**.compile**()**;**

Pattern: bungkus side-effect “non-deterministic” dalam injectable (Clock, Random, Network) sehingga bisa di-stub.

### Test untuk Guard, Pipe, Interceptor

Guard dan pipe testable terpisah — tapi di praktiknya cukup ditest via e2e satu kali (smoke), kombinasi dengan unit test untuk logic-nya (canActivate yang return boolean tertentu di kondisi tertentu).

*// roles.guard.spec.ts*\
import { describe**,** it**,** expect**,** vi } from 'vitest'**;**\
import { ExecutionContext**,** ForbiddenException } from '@nestjs/common'**;**\
import { Reflector } from '@nestjs/core'**;**\
import { RolesGuard } from './roles.guard'**;**\
\
**const** ctx **=** (user**:** { role**:** string } **\|** null**,** required**:** string\[\]) **=\>**\
({\
switchToHttp**:** () **=\>** ({ getRequest**:** () **=\>** ({ user }) })**,**\
getHandler**:** () **=\>** ({})**,**\
getClass**:** () **=\>** ({})**,**\
} as unknown as ExecutionContext)**;**\
\
**it**('allows when role matches'**,** () **=\>** {\
**const** reflector **=** { getAllAndOverride**:** () **=\>** \['admin'\] } as unknown as Reflector**;**\
**const** g **=** **new** **RolesGuard**(reflector)**;**\
**expect**(g**.canActivate**(**ctx**({ role**:** 'admin' }**,** \['admin'\])))**.toBe**(**true**)**;**\
})**;**\
\
**it**('throws when role does not match'**,** () **=\>** {\
**const** reflector **=** { getAllAndOverride**:** () **=\>** \['admin'\] } as unknown as Reflector**;**\
**const** g **=** **new** **RolesGuard**(reflector)**;**\
**expect**(() **=\>** g**.canActivate**(**ctx**({ role**:** 'staff' }**,** \['admin'\])))**.toThrow**(ForbiddenException)**;**\
})**;**

### Anti-pattern

- **Mock semua, tidak pernah test repository atau wiring nyata.** Service “lulus” tapi bug muncul di prod karena query Drizzle salah.

- **Test nge-import AppModule untuk unit test.** Bootstrap full app butuh DB, Redis — itu integration/e2e, bukan unit.

- **Database test dishare antar suite tanpa cleanup.** Test order-dependent. Pakai container per suite, atau truncate di beforeEach.

- **expect(...).toBeTruthy() sebagai default.** Lemah; gagal-aman. Pakai toEqual dengan struktur eksplisit.

- **Coverage 100% sebagai gate, tanpa test design.** Test yang asal lewat (misalnya cuma expect(fn).toBeDefined()) lulus tapi useless.

- **Stub yang tidak pernah di-verify.** vi.fn() tanpa expect(spy).toHaveBeenCalledWith(...) — interaksi tidak diverifikasi, regresi tidak ketahuan.

- **Test pakai waktu nyata (new Date())** sehingga flake di tengah malam atau di timezone berbeda. Inject Clock.

### Definition of Done — Pilar 5

- [ ] Vitest dipakai sebagai test runner; setup di-share via vitest.config.ts.

- [ ] Service punya unit test dengan repository di-mock; logic critical path tertutup.

- [ ] Repository punya integration test pakai Testcontainers; query yang dipakai di prod terverifikasi.

- [ ] E2E smoke test untuk endpoint utama, via app.inject().

- [ ] Coverage ≥ 80% lines untuk service & repository, blok PR kalau turun.

- [ ] Bug-fix disertai regression test.

- [ ] Tidak ada imports: \[AppModule\] di unit test.

- [ ] Side-effect non-deterministic (waktu, random, network) di-bungkus injectable.

## Pilar 6 — Observability (OpenTelemetry + Grafana)

### Prinsip

Production tanpa observability = debug pakai console.log dan firasat. Tiga sinyal: **logs, metrics, traces**. OpenTelemetry adalah standar vendor-neutral untuk ketiganya — instrumentasi sekali, kirim ke backend mana saja (Tempo, Jaeger, Datadog, dst).

Stack default tim: - **Logs:** nestjs-pino (JSON) → stdout → Loki (via Promtail/Alloy) - **Metrics:** OpenTelemetry SDK → Prometheus/Mimir - **Traces:** OpenTelemetry SDK → Tempo - **Visualisasi:** Grafana

Tujuan utama: **MTTR rendah**. Saat insiden, 90% waktu hilang karena tidak tahu apa yang terjadi. Observability yang baik bawa itu ke menit, bukan jam.

### Aturan praktis

- **Log structured (JSON), bukan string concat.** logger.info({ userId, orderId }, 'order placed'), bukan logger.info(\order \${orderId} placed for \${userId}\`)\`.

- **Setiap log punya request-id** (Fastify req.id). Pino otomatis ikut kalau pakai nestjs-pino dengan Fastify integration.

- **Level log: info untuk milestone bisnis, warn untuk recoverable anomaly, error untuk unexpected exception, debug untuk dev.** Jangan info untuk segalanya.

- **Jangan log PII.** No password, no token, no full credit-card. Pino redact wajib aktif untuk path field sensitif.

- **Metrics RED untuk tiap service** (Rate, Errors, Duration) — auto via OTel HTTP instrumentation. Tambah custom counter/histogram untuk metric bisnis (orders_placed_total, payment_amount_seconds).

- **Trace context propagated lintas service.** OTel auto-handle untuk HTTP outbound dengan @opentelemetry/instrumentation-undici atau instrumentation-http.

- **Health probe terpisah.** /healthz (liveness) ringan, hanya cek proses hidup. /readyz (readiness) cek dependency (DB ping, Redis ping).

- **SLO didokumentasikan.** Latency p95 di bawah X ms untuk endpoint utama, error rate \< Y%. Alert berdasar SLO, bukan threshold semaunya.

### Logger production: nestjs-pino

*// src/infrastructure/logger/logger.module.ts*\
import { Module } from '@nestjs/common'**;**\
import { LoggerModule } from 'nestjs-pino'**;**\
import { ConfigModule**,** ConfigService } from '@nestjs/config'**;**\
import type { AppConfig } from '../../config/configuration'**;**\
\
@**Module**({\
imports**:** \[\
LoggerModule**.forRootAsync**({\
imports**:** \[ConfigModule\]**,**\
inject**:** \[ConfigService\]**,**\
useFactory**:** (config**:** ConfigService**\<**AppConfig**,** **true\>**) **=\>** ({\
pinoHttp**:** {\
level**:** config**.get**('logLevel'**,** { infer**:** **true** })**,**\
autoLogging**:** **true,**\
customProps**:** (req) **=\>** ({ requestId**:** req**.**id })**,**\
redact**:** {\
paths**:** \[\
'req.headers.authorization'**,**\
'req.headers.cookie'**,**\
'req.body.password'**,**\
'req.body.token'**,**\
'\*.password'**,**\
'\*.passwordHash'**,**\
\]**,**\
censor**:** '\[REDACTED\]'**,**\
}**,**\
serializers**:** {\
req**:** (req) **=\>** ({ method**:** req**.**method**,** url**:** req**.**url**,** id**:** req**.**id })**,**\
res**:** (res) **=\>** ({ statusCode**:** res**.**statusCode })**,**\
}**,**\
transport**:** config**.get**('nodeEnv'**,** { infer**:** **true** }) **===** 'development'\
**?** { target**:** 'pino-pretty'**,** options**:** { singleLine**:** **true** } }\
**:** **undefined,**\
}**,**\
})**,**\
})**,**\
\]**,**\
})\
export **class** AppLoggerModule {}

### Pakai logger di service

import { Injectable } from '@nestjs/common'**;**\
import { PinoLogger**,** InjectPinoLogger } from 'nestjs-pino'**;**\
\
@**Injectable**()\
export **class** OrdersService {\
**constructor**(\
@**InjectPinoLogger**(OrdersService**.**name) **private** **readonly** logger**:** PinoLogger**,**\
**private** **readonly** repo**:** OrdersRepository**,**\
) {}\
\
**async** **place**(userId**:** string**,** items**:** CartItem\[\]) {\
**const** order **=** **await** **this.**repo**.create**({ userId**,** items })**;**\
**this.**logger**.info**({ userId**,** orderId**:** order**.**id**,** itemCount**:** items**.**length }**,** 'order placed')**;**\
**return** order**;**\
}\
}

### Apa yang HARUS dan TIDAK boleh di-log

| Boleh | Tidak |
|----|----|
| User-id, order-id, request-id | Password (plain atau hash), JWT, refresh token, API key |
| Action + outcome | Full credit card, CVV, NIK |
| Durasi operasi (ms) | Body lengkap untuk endpoint sensitif (auth, payment) |
| Error message + stack (server-side) | Stack ke client response |
| Database query duration agregat | SQL parameter yang berisi PII |

### OpenTelemetry SDK setup

*// src/observability/tracing.ts*\
import { NodeSDK } from '@opentelemetry/sdk-node'**;**\
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'**;**\
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'**;**\
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'**;**\
import { resourceFromAttributes } from '@opentelemetry/resources'**;**\
import { ATTR_SERVICE_NAME**,** ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'**;**\
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'**;**\
\
**const** otlpEndpoint **=** process**.**env**.**OTEL_EXPORTER_OTLP_ENDPOINT**;**\
**if** (**!**otlpEndpoint) {\
*// observability boleh nonaktif di local; di prod env ini wajib ada*\
*// eslint-disable-next-line no-console*\
console**.warn**('OTEL endpoint not set — telemetry disabled')**;**\
}\
\
export **const** otelSdk **=** **new** **NodeSDK**({\
resource**:** **resourceFromAttributes**({\
\[ATTR_SERVICE_NAME\]**:** process**.**env**.**OTEL_SERVICE_NAME **??** 'orders-service'**,**\
\[ATTR_SERVICE_VERSION\]**:** process**.**env**.**SERVICE_VERSION **??** '0.0.0'**,**\
})**,**\
traceExporter**:** otlpEndpoint **?** **new** **OTLPTraceExporter**({ url**:** \`**\${**otlpEndpoint**}**/v1/traces\` }) **:** undefined**,**\
metricReader**:** otlpEndpoint\
**?** **new** **PeriodicExportingMetricReader**({\
exporter**:** **new** **OTLPMetricExporter**({ url**:** \`**\${**otlpEndpoint**}**/v1/metrics\` })**,**\
exportIntervalMillis**:** 15_000**,**\
})\
**:** undefined**,**\
instrumentations**:** \[\
**getNodeAutoInstrumentations**({\
'@opentelemetry/instrumentation-fs'**:** { enabled**:** **false** }**,** *// noisy*\
'@opentelemetry/instrumentation-pino'**:** { enabled**:** **true** }**,**\
})**,**\
\]**,**\
})**;**\
\
otelSdk**.start**()**;**\
\
process**.on**('SIGTERM'**,** () **=\>** {\
otelSdk**.shutdown**()**.catch**(() **=\>** {})**.finally**(() **=\>** process**.exit**(0))**;**\
})**;**

tracing.ts **harus di-import paling awal** — sebelum NestFactory.create, sebelum module apapun yang akan di-instrument.

*// src/main.ts (potongan, paling atas)*\
import './observability/tracing'**;** *// WAJIB paling awal*\
import { NestFactory } from '@nestjs/core'**;**\
*// ...*

Auto-instrumentation menangani: HTTP server, HTTP/undici client, pg (database), ioredis, Pino. Tambahan custom instrumentation untuk BullMQ ada di Pilar 7.

### Custom metric

*// src/observability/metrics.ts*\
import { metrics } from '@opentelemetry/api'**;**\
\
**const** meter **=** metrics**.getMeter**('orders-service')**;**\
\
export **const** ordersPlacedCounter **=** meter**.createCounter**('orders_placed_total'**,** {\
description**:** 'Total orders successfully placed'**,**\
})**;**\
\
export **const** orderProcessingHistogram **=** meter**.createHistogram**('order_processing_seconds'**,** {\
description**:** 'Order processing duration'**,**\
unit**:** 's'**,**\
})**;**

*// dipakai di service*\
ordersPlacedCounter**.add**(1**,** { region**:** 'id-jkt-1' })**;**\
**const** start **=** process**.hrtime.bigint**()**;**\
*// ...*\
orderProcessingHistogram**.record**(Number(process**.hrtime.bigint**() **-** start) **/** 1e9)**;**

### Distributed tracing — span manual

Auto-instrumentation cukup untuk 80% kasus. Untuk operasi spesifik (parsing, business logic mahal), buat span manual:

import { trace } from '@opentelemetry/api'**;**\
\
**const** tracer **=** trace**.getTracer**('orders-service')**;**\
\
**async** **pricingCalculation**(items**:** CartItem\[\]) {\
**return** tracer**.startActiveSpan**('pricing.calculate'**,** **async** (span) **=\>** {\
**try** {\
span**.setAttribute**('items.count'**,** items**.**length)**;**\
**const** result **=** **await** **this.calc**(items)**;**\
span**.setAttribute**('total.cents'**,** result**.**totalCents)**;**\
**return** result**;**\
} **catch** (err) {\
span**.recordException**(err as Error)**;**\
span**.setStatus**({ code**:** 2 */\* ERROR \*/* })**;**\
**throw** err**;**\
} **finally** {\
span**.end**()**;**\
}\
})**;**\
}

### Health check dengan @nestjs/terminus

*// src/modules/health/health.controller.ts*\
import { Controller**,** Get } from '@nestjs/common'**;**\
import { HealthCheck**,** HealthCheckService**,** HttpHealthIndicator } from '@nestjs/terminus'**;**\
import { Public } from '../../common/decorators/public.decorator'**;**\
import { DrizzleHealthIndicator } from './drizzle.health'**;**\
import { RedisHealthIndicator } from './redis.health'**;**\
\
@**Controller**()\
export **class** HealthController {\
**constructor**(\
**private** **readonly** health**:** HealthCheckService**,**\
**private** **readonly** drizzleH**:** DrizzleHealthIndicator**,**\
**private** **readonly** redisH**:** RedisHealthIndicator**,**\
) {}\
\
@**Public**()\
@**Get**('healthz') *// liveness — apakah proses ini hidup?*\
@**HealthCheck**()\
**liveness**() {\
**return** **this.**health**.check**(\[\])**;** *// kosong: kalau bisa respond, hidup*\
}\
\
@**Public**()\
@**Get**('readyz') *// readiness — siap menerima traffic?*\
@**HealthCheck**()\
**readiness**() {\
**return** **this.**health**.check**(\[\
() **=\>** **this.**drizzleH**.pingCheck**('database')**,**\
() **=\>** **this.**redisH**.pingCheck**('redis')**,**\
\])**;**\
}\
}

K8s probe wiring ada di Pilar 9.

### Anti-pattern

- \*\*Log string concat (\user \${id} did X\`).\*\* Tidak bisa di-query terstruktur. Gunakan object:{ userId: id, action: ‘X’ }\`.

- **Log PII (password, token, full card).** Audit risk + compliance issue. Pino redact + review berkala.

- **Tracing di-init setelah modul lain.** Modul yang sudah di-load tidak ter-instrument. tracing.ts paling awal.

- **/healthz cek DB.** Kalau DB lambat, K8s kill semua pod sekaligus → cascade outage. Liveness ringan, readiness cek dependency.

- **Metric kardinalitas tinggi** (label berisi user-id, order-id). Prometheus/Mimir meledak. Label hanya untuk dimensi rendah-kardinalitas (region, status, route template).

- **Alert on threshold tanpa SLO.** “CPU \> 80% alert” tidak menjawab apakah user terdampak. Alert on SLO (latency p95, error rate).

### Definition of Done — Pilar 6

- [ ] Logger pino aktif, JSON di prod, redact field sensitif.

- [ ] OTel SDK di-init paling awal di main.ts; auto-instrumentation HTTP/pg/redis/pino aktif.

- [ ] Setiap log line punya request-id; trace-id di-correlate di Grafana.

- [ ] Custom metric untuk milestone bisnis utama (orders, payments, signups).

- [ ] /healthz (liveness) dan /readyz (readiness) terpisah, public, dan di-wire ke K8s probe.

- [ ] SLO didokumentasikan untuk endpoint utama; alert di-link ke SLO.

- [ ] Dashboard Grafana untuk service ada; minimal panel: RED, error breakdown, dependency latency.

## Pilar 7 — Background Jobs & Queues (BullMQ)

### Prinsip

Tidak semua kerja harus selesai dalam HTTP request. Operasi yang lambat (kirim email, generate invoice PDF, recompute aggregate), retry-able (call ke external API yang flaky), atau berjalan terjadwal (cron) → pindahkan ke **queue**. Aturan main: HTTP handler **menerbitkan** job dan return cepat; **worker** mengeksekusi job di proses terpisah.

BullMQ (di atas Redis) memberi: retry exponential backoff, scheduled/repeatable job, priorities, rate limit per queue, dead-letter (failed queue), dan observability via Bull Board atau Grafana.

Tiga prinsip non-negotiable: 1. **Job harus idempotent.** Worker bisa crash di tengah, retry, dan tidak menghasilkan double-charge atau double-email. Pakai natural key (orderId) atau idempotency token. 2. **Job small dan focused.** Satu job = satu unit bisnis (kirim satu email, proses satu order). Jangan job “process all overnight” — itu monolith dalam queue. 3. **Failed job di-retain dan di-monitor.** Default BullMQ menghapus completed job; failed job tetap. Alert kalau backlog atau failed count melewati threshold.

### Aturan praktis

- **Pakai @nestjs/bullmq** untuk integrasi NestJS native (queue inject-able, processor decorator-driven).

- **Queue per concern, bukan per service.** email, invoice, analytics — bukan orders-queue yang mencampur semua.

- **Worker run di proses terpisah.** Same codebase, different entrypoint (worker.ts). Bisa scale independen di K8s (HPA berbeda).

- **Connection ke Redis lewat BullMQ shared options.** Reuse koneksi, jangan instantiate IORedis per queue.

- **Default removeOnComplete: { count: 1000 }** dan removeOnFail: { count: 5000 } — keep recent untuk debugging, jangan tumbuh tak terhingga.

- **Backoff exponential**, default attempts: 3, backoff: { type: 'exponential', delay: 1000 }. Tune per job.

- **Graceful shutdown wajib.** Worker harus worker.close() saat SIGTERM, biar job in-flight selesai.

- **Concurrency limit eksplisit** per worker. Default 1; naikkan sesuai kapasitas downstream (DB, external API). Lupa concurrency = bisa habiskan koneksi DB.

- **Scheduled job (cron) pakai repeat**. Jangan pakai setInterval di NestJS — hilang saat instance restart.

### Setup BullMQ root

*// src/infrastructure/queue/queue.module.ts*\
import { Module } from '@nestjs/common'**;**\
import { BullModule } from '@nestjs/bullmq'**;**\
import { ConfigModule**,** ConfigService } from '@nestjs/config'**;**\
import type { AppConfig } from '../../config/configuration'**;**\
\
@**Module**({\
imports**:** \[\
BullModule**.forRootAsync**({\
imports**:** \[ConfigModule\]**,**\
inject**:** \[ConfigService\]**,**\
useFactory**:** (config**:** ConfigService**\<**AppConfig**,** **true\>**) **=\>** ({\
connection**:** { url**:** config**.get**('redis.url'**,** { infer**:** **true** }) }**,**\
defaultJobOptions**:** {\
attempts**:** 3**,**\
backoff**:** { type**:** 'exponential'**,** delay**:** 1_000 }**,**\
removeOnComplete**:** { count**:** 1000 }**,**\
removeOnFail**:** { count**:** 5000 }**,**\
}**,**\
})**,**\
})**,**\
\]**,**\
})\
export **class** QueueModule {}

### Definisi queue + producer

*// src/modules/email/email.module.ts*\
import { Module } from '@nestjs/common'**;**\
import { BullModule } from '@nestjs/bullmq'**;**\
import { EmailService } from './email.service'**;**\
\
@**Module**({\
imports**:** \[BullModule**.registerQueue**({ name**:** 'email' })\]**,**\
providers**:** \[EmailService\]**,**\
exports**:** \[EmailService\]**,**\
})\
export **class** EmailModule {}

*// src/modules/email/email.service.ts*\
import { Injectable } from '@nestjs/common'**;**\
import { InjectQueue } from '@nestjs/bullmq'**;**\
import { Queue } from 'bullmq'**;**\
\
export **interface** SendEmailJob {\
to**:** string**;**\
templateId**:** string**;**\
variables**:** Record**\<**string**,** string**\>;**\
idempotencyKey**:** string**;** *// mis. \\order-confirm:\\{orderId}\\*\
}\
\
@**Injectable**()\
export **class** EmailService {\
**constructor**(@**InjectQueue**('email') **private** **readonly** queue**:** Queue**\<**SendEmailJob**\>**) {}\
\
**async** **sendOrderConfirmation**(orderId**:** string**,** to**:** string**,** vars**:** Record**\<**string**,** string**\>**) {\
**await** **this.**queue**.add**(\
'order-confirm'**,**\
{ to**,** templateId**:** 'order-confirm'**,** variables**:** vars**,** idempotencyKey**:** \`order-confirm:**\${**orderId**}**\` }**,**\
{ jobId**:** \`order-confirm:**\${**orderId**}**\` }**,** *// jobId = idempotency*\
)**;**\
}\
}

jobId yang sama → BullMQ tolak duplikasi. Itu lapisan idempotensi pertama; lapisan kedua adalah cek di consumer (sudah pernah dikirim?).

### Consumer (worker)

*// src/modules/email/email.processor.ts*\
import { Processor**,** WorkerHost**,** OnWorkerEvent } from '@nestjs/bullmq'**;**\
import { Logger } from '@nestjs/common'**;**\
import type { Job } from 'bullmq'**;**\
import type { SendEmailJob } from './email.service'**;**\
import { EmailGateway } from './email.gateway'**;**\
import { SentEmailRepository } from './sent-email.repository'**;**\
\
@**Processor**('email'**,** { concurrency**:** 10 }) *// 10 job paralel per worker*\
export **class** EmailProcessor **extends** WorkerHost {\
**private** **readonly** logger **=** **new** **Logger**(EmailProcessor**.**name)**;**\
\
**constructor**(\
**private** **readonly** gateway**:** EmailGateway**,**\
**private** **readonly** sent**:** SentEmailRepository**,**\
) { **super**()**;** }\
\
**async** process(job**:** Job**\<**SendEmailJob**\>**)**:** Promise**\<**{ messageId**:** string }**\>** {\
**const** existing **=** **await** **this.**sent**.findByIdempotencyKey**(job**.**data**.**idempotencyKey)**;**\
**if** (existing) {\
**this.**logger**.log**({ jobId**:** job**.**id**,** idempotencyKey**:** job**.**data**.**idempotencyKey }**,** 'already sent — skipping')**;**\
**return** { messageId**:** existing**.**messageId }**;**\
}\
\
**const** result **=** **await** **this.**gateway**.send**(job**.**data)**;**\
**await** **this.**sent**.record**({\
idempotencyKey**:** job**.**data**.**idempotencyKey**,**\
messageId**:** result**.**messageId**,**\
})**;**\
**return** result**;**\
}\
\
@**OnWorkerEvent**('failed')\
**onFailed**(job**:** Job**\<**SendEmailJob**\>,** err**:** Error) {\
**this.**logger**.error**({ jobId**:** job**.**id**,** attemptsMade**:** job**.**attemptsMade**,** err**:** err**.**message }**,** 'email job failed')**;**\
}\
}

### Entrypoint worker terpisah

*// src/worker.ts*\
import './observability/tracing'**;**\
import { NestFactory } from '@nestjs/core'**;**\
import { Logger } from 'nestjs-pino'**;**\
import { WorkerModule } from './worker.module'**;**\
\
**async** **function** **bootstrap**() {\
**const** app **=** **await** NestFactory**.createApplicationContext**(WorkerModule**,** { bufferLogs**:** **true** })**;**\
app**.useLogger**(app**.get**(Logger))**;**\
app**.enableShutdownHooks**()**;**\
app**.get**(Logger)**.log**('worker started')**;**\
*// proses tetap hidup; BullMQ Worker yang menerima job*\
}\
\
**void** **bootstrap**()**;**

WorkerModule hanya import processor module + infrastructure (DB, Redis, Logger, OTel) — tanpa Controller, tanpa Fastify. Build dengan entry berbeda; deploy sebagai Deployment K8s sendiri.

### Scheduled job (cron via BullMQ)

**async** **onModuleInit**() {\
**await** **this.**queue**.add**(\
'daily-report'**,**\
{}**,**\
{\
repeat**:** { pattern**:** '0 2 \* \* \*'**,** tz**:** 'Asia/Jakarta' }**,** *// jam 02:00 WIB*\
jobId**:** 'daily-report'**,** *// satu repeatable*\
removeOnComplete**:** { count**:** 30 }**,**\
}**,**\
)**;**\
}

Catatan: repeat BullMQ menyimpan key di Redis. Restart instance tidak duplikasi job. Tapi pastikan jobId konsisten — kalau berubah, akan ada multiple cron parallel.

### Dead-letter dan recovery

BullMQ menyimpan failed job di Redis (sesuai removeOnFail.count). Untuk recovery:

*// admin endpoint atau script ops*\
**async** **retryFailed**(queueName**:** string**,** count **=** 100) {\
**const** queue **=** **new** **Queue**(queueName**,** { connection })**;**\
**const** failed **=** **await** queue**.getFailed**(0**,** count **-** 1)**;**\
**for** (**const** job **of** failed) {\
**await** job**.retry**()**;**\
}\
}

Pasang dashboard (Bull Board) di route admin (di-protect) untuk monitor visual.

### Observability untuk worker

OTel auto-instrumentation untuk BullMQ belum stabil di semua versi. Tambah span manual:

import { trace**,** SpanStatusCode } from '@opentelemetry/api'**;**\
**const** tracer **=** trace**.getTracer**('email-worker')**;**\
\
**async** process(job**:** Job**\<**SendEmailJob**\>**) {\
**return** tracer**.startActiveSpan**(\`bullmq.process email\`**,** **async** (span) **=\>** {\
span**.setAttribute**('job.id'**,** job**.**id **??** '')**;**\
span**.setAttribute**('job.attempts'**,** job**.**attemptsMade)**;**\
**try** {\
*// ... kerja*\
} **catch** (err) {\
span**.recordException**(err as Error)**;**\
span**.setStatus**({ code**:** SpanStatusCode**.**ERROR })**;**\
**throw** err**;**\
} **finally** {\
span**.end**()**;**\
}\
})**;**\
}

Metric custom: bullmq_jobs_processed_total{queue, status}, bullmq_job_duration_seconds{queue}.

### Anti-pattern

- **Job tidak idempotent.** Retry → double-charge. Selalu pakai natural key atau idempotency token, plus cek di consumer.

- **Concurrency unlimited.** Worker accept job sebanyak-banyaknya, koneksi DB/external habis dalam menit. Batas eksplisit per worker.

- **Worker run di proses HTTP yang sama.** Memakan CPU yang harusnya untuk request, scaling jadi terikat. Pisah proses.

- **Tidak ada graceful shutdown.** SIGTERM → job aktif terbunuh tengah jalan → state inkonsisten. app.enableShutdownHooks() + BullMQ worker.close().

- **Failed queue tidak di-monitor.** Job gagal diam-diam berhari-hari, baru ketahuan dari customer complaint.

- **Schedule pakai setInterval.** Hilang saat restart, tidak terkoordinasi antar instance. Pakai repeat BullMQ.

- **Job berbobot besar (process semua user)**. Crash di tengah, retry mulai dari awal. Pecah jadi banyak job kecil.

### Definition of Done — Pilar 7

- [ ] Job didefinisikan idempotent (jobId atau idempotency key + cek di consumer).

- [ ] Worker run di proses terpisah, dengan enableShutdownHooks().

- [ ] Concurrency limit eksplisit, di-tune sesuai kapasitas downstream.

- [ ] Backoff exponential aktif; failed job di-retain dengan count terbatas.

- [ ] Schedule pakai repeat (bukan setInterval); jobId konsisten.

- [ ] Monitoring: queue depth, processing duration, failed count → metric → alert.

- [ ] Dashboard ops (Bull Board atau Grafana) untuk visibilitas.

## Pilar 8 — Migrations Strategy

### Prinsip

Migration adalah **deployment ritual**. Salah migration = downtime atau data loss. Tiga aturan keras:

1.  **Migration di-generate, di-review, di-commit.** Tidak ada migration lewat console di prod.

2.  **Migration di-apply lewat pipeline, bukan di app startup.** Kalau di startup, multi-instance K8s race; kalau gagal, ribuan replica restart-loop.

3.  **Skema yang berbahaya pakai expand-contract.** Tambah dulu, deploy, isi data, lalu hapus yang lama. Tidak pernah ALTER TABLE DROP COLUMN bersamaan dengan deploy yang masih pakai kolom itu.

### Aturan praktis

- **Source of truth: src/infrastructure/database/schema/\*.ts.** Tidak pernah edit migration SQL manual sebagai alat utama; edit schema, generate.

- **Generate: pnpm drizzle-kit generate.** Output ke drizzle/. File migration di-commit ke git.

- **Apply: pnpm drizzle-kit migrate.** Jalan di pipeline CI/CD sebelum aplikasi roll out.

- **Migration harus reversible-by-design.** Bukan berarti tiap migration punya down; tapi setiap perubahan harus dipikirkan: kalau gagal di prod, apa langkah recovery? Backup + replay?

- **Expand-contract untuk perubahan kolom yang dipakai code.** Tidak rename kolom dalam satu deploy — pecah jadi 3.

- **Backfill data-migration sebagai job, bukan SQL inline di file migration.** Migration SQL untuk DDL (struktur). Data-migration besar di BullMQ job idempotent.

- **Tidak ada ALTER TABLE yang lock long-running di prod.** Di Postgres, hindari ALTER TABLE ... ADD COLUMN ... DEFAULT non-trivial di tabel besar (lock + rewrite). Pakai pola: add nullable → backfill → set NOT NULL.

- **drizzle-kit check** dijalankan di CI untuk deteksi schema drift.

### Workflow drizzle-kit

*\# 1. Edit src/infrastructure/database/schema/\*.ts*\
\
*\# 2. Generate file migrasi*\
pnpm drizzle-kit generate\
*\# → menghasilkan drizzle/0007_add_users_phone.sql*\
\
*\# 3. Review file SQL — pastikan tidak ada operasi destruktif tak diharapkan*\
**git** diff drizzle/\
\
*\# 4. Commit schema + migration bersama (satu PR)*\
**git** add src/infrastructure/database/schema drizzle/\
**git** commit -m "feat(users): add phone column"\
\
*\# 5. Di pipeline CI/CD, sebelum deploy:*\
pnpm drizzle-kit migrate

Konfigurasi:

*// drizzle.config.ts*\
import { defineConfig } from 'drizzle-kit'**;**\
\
export default **defineConfig**({\
schema**:** './src/infrastructure/database/schema/index.ts'**,**\
out**:** './drizzle'**,**\
dialect**:** 'postgresql'**,**\
dbCredentials**:** { url**:** process**.**env**.**DATABASE_URL**!** }**,**\
strict**:** **true,**\
verbose**:** **true,**\
})**;**

### Pattern: expand-contract (rename kolom)

Skenario: rename users.full_name → users.display_name.

**Salah (single-step):**

**ALTER** **TABLE** users **RENAME** **COLUMN** full_name **TO** display_name;

Pod lama (yang masih query full_name) crash sampai semua roll out. Downtime.

**Benar (expand-contract):**

**Deploy 1 — Expand.** - Tambah kolom baru display_name, nullable. - Trigger atau code dual-write: INSERT/UPDATE ke kedua kolom.

*-- migration 0008_expand_display_name.sql*\
**ALTER** **TABLE** users **ADD** **COLUMN** display_name varchar(120);\
**UPDATE** users **SET** display_name **=** full_name **WHERE** display_name **IS** **NULL**;

Code: tulis ke kedua kolom, baca dari kolom lama.

**Deploy 2 — Switch read.** - Code baca dari display_name. - Tetap dual-write.

**Deploy 3 — Contract.** - Hentikan tulis ke full_name. - Drop full_name.

*-- migration 0010_contract_drop_full_name.sql*\
**ALTER** **TABLE** users **DROP** **COLUMN** full_name;

3 deploy, 0 downtime. Trade-off: butuh disiplin.

### Pattern: tambah kolom NOT NULL ke tabel besar

**Salah:**

**ALTER** **TABLE** orders **ADD** **COLUMN** region varchar(2) **NOT** **NULL** **DEFAULT** 'id';

Postgres \< 11 rewrite seluruh tabel (lock). Postgres 11+ optimize default constant, tapi tetap risky kalau default berdasarkan ekspresi atau column lain.

**Benar:**

*-- step 1*\
**ALTER** **TABLE** orders **ADD** **COLUMN** region varchar(2);\
\
*-- step 2 — backfill di batch (job, bukan migration)*\
*-- jalan via worker BullMQ atau script ops, batch 1000 baris*\
**UPDATE** orders **SET** region **=** 'id' **WHERE** region **IS** **NULL** **AND** **id** **BETWEEN** **..**. **AND** **..**.;\
\
*-- step 3 — setelah backfill selesai*\
**ALTER** **TABLE** orders **ALTER** **COLUMN** region **SET** **NOT** **NULL**;\
**ALTER** **TABLE** orders **ALTER** **COLUMN** region **SET** **DEFAULT** 'id';

Code dual-handle: terima null sementara (default di service), setelah SET NOT NULL aman.

### Index creation di tabel besar

*-- WAJIB CONCURRENTLY untuk index di tabel produksi besar*\
**CREATE** **INDEX** CONCURRENTLY orders_user_id_idx **ON** orders(user_id);

drizzle-kit menghasilkan CREATE INDEX biasa. Tambah CONCURRENTLY manual di file migrasi yang dihasilkan, atau pakai custom statement. CONCURRENTLY tidak bisa di transaction, jadi migration tersebut harus di-flag tidak transactional (komen di header file migration).

### Rollback discipline

- **Backup terbaru sebelum migration produksi.** PITR (point-in-time recovery) Postgres sudah ada — pastikan retention cukup (minimal 7 hari).

- **Migration “down” dipikirkan, tidak otomatis di-apply.** Drizzle tidak generate down by default, dan itu sengaja — banyak operasi tidak benar-benar reversible (drop column, drop data).

- **Strategi rollback:** kalau migration broken di prod dan bukan data loss, deploy versi code sebelumnya yang masih kompatibel; perbaiki schema di follow-up. Kalau ada data loss, restore dari backup ke staging, recover yang relevan.

- **Test migration di staging dengan data-shape produksi.** Snapshot anonymized → restore di staging → run migration → verifikasi.

### CI/CD integration

*\# .github/workflows/deploy.yml (potongan)*\
**jobs:**\
**deploy:**\
**steps:**\
**-** **name:** Run migrations\
**run:** pnpm drizzle-kit migrate\
**env:**\
**DATABASE_URL:** \${{ secrets.PROD_DATABASE_URL }}\
\
**-** **name:** Deploy app\
**run:** kubectl rollout restart deployment/orders-service

Migration **selesai sebelum** rollout app. Kalau migration gagal, deploy abort — app lama tetap jalan dengan schema lama.

### Anti-pattern

- **Migration di onApplicationBootstrap.** Race antara replica, gagal-restart loop. Pipeline.

- **Edit migration file yang sudah merged.** drizzle-kit men-track journal; mengedit yang sudah ter-apply di prod menyebabkan hash mismatch. Tambah migration baru.

- **Drop column di deploy yang code-nya masih pakai.** Crash. Expand-contract.

- **ALTER TABLE besar di jam puncak.** Lock acquisition mungkin lama dan blok semua tulis. Jadwalkan di low-traffic, atau pecah lebih kecil.

- **Backfill di file migration untuk tabel besar.** Migration tunggal jalan jam-jaman, blok deploy. Pisah jadi job idempotent.

- **Tidak ada test migration.** Migration broken baru ketahuan di prod. Test minimal: jalankan dari fresh DB di CI.

### Definition of Done — Pilar 8

- [ ] Schema TypeScript adalah source of truth; migration di-generate via drizzle-kit.

- [ ] File migration di-review di PR yang sama dengan perubahan schema.

- [ ] Migration di-apply di CI/CD step terpisah, sebelum app rollout.

- [ ] Perubahan kolom yang dipakai code mengikuti expand-contract; tidak ada single-step rename/drop.

- [ ] ADD COLUMN NOT NULL ke tabel besar dipecah: nullable → backfill (job) → set NOT NULL.

- [ ] CREATE INDEX CONCURRENTLY untuk tabel besar di prod.

- [ ] Backup PITR aktif; retention dokumentasikan.

- [ ] Migration di-test di staging dengan data-shape produksi sebelum deploy prod.

## Pilar 9 — Containerization & Deployment

### Prinsip

**Container Anda adalah artifact deploy**, bukan alat dev. Itu artinya: image kecil, attack surface minimal, deterministic build, signed. Kubernetes tidak ajaib — ia hanya menjalankan container; kalau container Anda butuh 30 detik bootstrap, K8s tidak bisa fix itu, dan rolling update Anda jadi bencana.

Empat hal yang sering jadi penyebab outage: 1. Image bloat → cold-start lambat → autoscaling lag → backlog request. 2. Probe yang salah-konfigurasi → K8s kill pod sehat / lupa kill pod tidak sehat. 3. Tidak ada graceful shutdown → in-flight request hilang saat scale-down. 4. Resource request/limit asal → CPU throttle silent / OOMKilled tanpa warning.

### Aturan praktis

- **Multi-stage Docker.** Stage build (besar, dependencies + compile), stage runtime (kecil, hanya artifact + node_modules production).

- **Base runtime: distroless gcr.io/distroless/nodejs22-debian12** untuk minimal attack surface. Alternatif: node:22-alpine (lebih kecil, tapi musl libc kadang bermasalah dengan native module — pakai kalau Anda yakin tidak butuh native).

- **Pakai pnpm di CI dengan lockfile.** pnpm install --frozen-lockfile untuk deterministic.

- **USER nonroot** — jangan run sebagai root (distroless punya user nonroot UID 65532).

- **Healthcheck di Dockerfile** opsional (K8s probe yang utama).

- **Resource request = baseline normal**, **limit = batas sebelum killed/throttle**. Jangan request 1 CPU kalau biasanya pakai 100m — bikin scheduler salokasi.

- **Liveness probe ringan** (TCP atau /healthz kosong). **Readiness probe** cek dependency (/readyz).

- **preStop hook** untuk delay sebelum SIGTERM, biar load balancer sempat de-register pod.

- **terminationGracePeriodSeconds ≥ shutdown time aplikasi.** Default K8s 30 detik; kalau worker BullMQ punya job lama, naikkan.

- **Config via env**, secret via Secret K8s atau External Secrets Operator. Tidak embed di image.

- **Tag image immutable** (commit SHA atau semver), bukan :latest.

### Multi-stage Dockerfile

*\# **syntax=docker/dockerfile:1.7***\
**ARG** NODE_VERSION=22\
\
*\# ---------- Stage 1: deps ----------*\
**FROM** node:\${NODE_VERSION}-alpine **AS** deps\
**WORKDIR** /app\
**RUN** corepack enable **&&** corepack prepare pnpm@latest --activate\
**COPY** package.json pnpm-lock.yaml ./\
**RUN** **--mount=type=cache,id=pnpm,target=/pnpm/store** **\\**\
pnpm config set store-dir /pnpm/store **&&** \\\
pnpm install --frozen-lockfile\
\
*\# ---------- Stage 2: build ----------*\
**FROM** node:\${NODE_VERSION}-alpine **AS** build\
**WORKDIR** /app\
**RUN** corepack enable **&&** corepack prepare pnpm@latest --activate\
**COPY** **--from=deps** /app/node_modules ./node_modules\
**COPY** . .\
**RUN** pnpm run build\
\
*\# Prune dev deps untuk production node_modules ramping*\
**RUN** **--mount=type=cache,id=pnpm,target=/pnpm/store** **\\**\
pnpm config set store-dir /pnpm/store **&&** \\\
pnpm prune --prod\
\
*\# ---------- Stage 3: runtime ----------*\
**FROM** gcr.io/distroless/nodejs22-debian12 **AS** runtime\
**WORKDIR** /app\
**ENV** NODE_ENV=production\
\
**COPY** **--from=build** /app/node_modules ./node_modules\
**COPY** **--from=build** /app/dist ./dist\
**COPY** **--from=build** /app/drizzle ./drizzle\
**COPY** **--from=build** /app/package.json ./package.json\
\
**USER** nonroot\
**EXPOSE** 3000\
\
**CMD** \["dist/main.js"\]

Untuk worker, **build image terpisah** (Dockerfile yang sama, CMD berbeda: `CMD ["dist/worker.js"]`). Jangan coba shell-substitution di JSON-form CMD seperti `CMD ["dist/${ENTRYPOINT:-main}.js"]` — exec form tidak shell-expand, dan distroless tidak punya `/bin/sh` sama sekali. Pattern yang benar: dua image dengan tag berbeda dari Dockerfile yang sama, atau satu Dockerfile dengan `ARG ENTRYPOINT` build-time + dua build invocation. Hindari kreatif di runtime karena distroless akan literal mencari file `dist/${ENTRYPOINT}.js`.

.dockerignore wajib:

node_modules\
dist\
.git\
.env\
.env.\*\
\*\*/\*.spec.ts\
\*\*/\*.int-spec.ts\
test/\
coverage/\
README.md\
.vscode\
.idea

### Health probe wiring di K8s

*\# k8s/deployment.yaml (potongan)*\
**apiVersion:** apps/v1\
**kind:** Deployment\
**metadata:**\
**name:** orders-service\
**spec:**\
**replicas:** 3\
**template:**\
**spec:**\
**terminationGracePeriodSeconds:** 60\
**containers:**\
**-** **name:** app\
**image:** registry.example.com/orders-service:abc123\
**ports:**\
**-** **containerPort:** 3000\
**env:**\
**-** **name:** NODE_ENV\
**value:** production\
**-** **name:** DATABASE_URL\
**valueFrom:** **{** **secretKeyRef:** **{** **name:** orders-secrets**,** **key:** database-url **}** **}**\
**resources:**\
**requests:** **{** **cpu:** 200m**,** **memory:** 256Mi **}**\
**limits:** **{** **cpu:** 1000m**,** **memory:** 512Mi **}**\
**startupProbe:**\
**httpGet:** **{** **path:** /healthz**,** **port:** 3000 **}**\
**periodSeconds:** 5\
**failureThreshold:** 30 *\# 30\*5s = 150s untuk start-up lambat*\
**livenessProbe:**\
**httpGet:** **{** **path:** /healthz**,** **port:** 3000 **}**\
**periodSeconds:** 10\
**timeoutSeconds:** 2\
**failureThreshold:** 3\
**readinessProbe:**\
**httpGet:** **{** **path:** /readyz**,** **port:** 3000 **}**\
**periodSeconds:** 5\
**timeoutSeconds:** 2\
**failureThreshold:** 3\
**lifecycle:**\
**preStop:**\
**httpGet:** *\# distroless tidak punya /bin/sh — pakai httpGet, bukan exec*\
**path:** /shutdown\
**port:** 3000

Catatan: `preStop.httpGet` jalan di distroless karena tidak butuh shell. Endpoint `/shutdown` adalah controller yang sleep 5 detik lalu return 200 — tujuannya beri waktu kube-proxy/ingress de-register endpoint sebelum aplikasi berhenti accept koneksi. Implementasi handler:

```ts
// src/modules/health/health.controller.ts (tambahkan)
@Public()
@Get('shutdown')
async shutdown(): Promise<{ ok: true }> {
  // Dipanggil oleh K8s preStop. Tunggu agar LB sempat de-register pod
  // sebelum SIGTERM dikirim & app.close() jalan.
  await new Promise((r) => setTimeout(r, 5000));
  return { ok: true };
}
```

Alternatif minimalis: hapus `preStop` sama sekali dan handle SIGTERM di app dengan delay 5 detik sebelum `app.close()`. Trade-off: kalau pod ter-replace cepat, race window lebih besar karena LB dan SIGTERM tidak terkoordinasi.

### Graceful shutdown di NestJS

enableShutdownHooks() (lihat Pilar 1) men-trigger OnModuleDestroy saat SIGTERM. Tambahan: di Fastify, pakai app.close() untuk hentikan accept koneksi baru sebelum OnModuleDestroy.

*// di main.ts (potongan, ditambahkan setelah enableShutdownHooks)*\
**const** shutdown **=** **async** (signal**:** string) **=\>** {\
app**.get**(Logger)**.log**(\`received **\${**signal**}**, shutting down\`)**;**\
**await** app**.close**()**;**\
}**;**\
process**.on**('SIGTERM'**,** () **=\>** **void** **shutdown**('SIGTERM'))**;**\
process**.on**('SIGINT'**,** () **=\>** **void** **shutdown**('SIGINT'))**;**

app.close() memanggil semua OnModuleDestroy — termasuk DrizzleService.onModuleDestroy() yang close pool, dan BullMQ worker close() yang membiarkan job aktif selesai (sampai timeout).

### Resource sizing

Tanpa data: tebak berdasarkan profil generic, observe, tune.

| Profil                           | Request CPU | Request Mem | Limit CPU | Limit Mem |
|----------------------------------|-------------|-------------|-----------|-----------|
| API ringan, low-traffic          | 100m        | 128Mi       | 500m      | 256Mi     |
| API utama                        | 200m        | 256Mi       | 1000m     | 512Mi     |
| Worker BullMQ ringan             | 100m        | 256Mi       | 500m      | 512Mi     |
| Worker dengan transformasi besar | 500m        | 1Gi         | 2000m     | 2Gi       |

Dengan data: ambil p95 actual dari Grafana, set request = p95 × 1.2, limit = request × 2 (kasar). Iterate.

### HPA (Horizontal Pod Autoscaler)

**apiVersion:** autoscaling/v2\
**kind:** HorizontalPodAutoscaler\
**metadata:**\
**name:** orders-service\
**spec:**\
**scaleTargetRef:** **{** **apiVersion:** apps/v1**,** **kind:** Deployment**,** **name:** orders-service **}**\
**minReplicas:** 3\
**maxReplicas:** 20\
**metrics:**\
**-** **type:** Resource\
**resource:** **{** **name:** cpu**,** **target:** **{** **type:** Utilization**,** **averageUtilization:** 70 **}** **}**

Untuk worker, scale berdasarkan queue depth (KEDA + BullMQ scaler) lebih tepat dibanding CPU.

### Anti-pattern

- **Image node:22 (full) di runtime.** ~1 GB; cold pull memperlambat scale-out. Pakai distroless atau alpine.

- **USER root.** Vulnerability container escape lebih impactful. Selalu non-root.

- **Liveness probe hit /readyz (cek DB).** DB hiccup → semua pod ditandai unhealthy → K8s kill semua → outage. Liveness ringan, readiness cek dependency.

- **terminationGracePeriodSeconds: 30 dengan worker yang punya job 5 menit.** SIGTERM → SIGKILL paksa → job state inkonsisten. Tune sesuai workload.

- **Image :latest.** Rollback tidak deterministic, audit trail rusak. Tag = commit SHA atau semver.

- **Resource limit lebih kecil dari biasa pakai.** Throttling silent — service “lambat” tanpa alert obvious. Sizing berdasar observasi.

- **Migration di entrypoint container.** Race antara replica. Migration job terpisah (Job K8s atau pipeline step).

### Definition of Done — Pilar 9

- [ ] Dockerfile multi-stage; runtime image distroless atau alpine; non-root.

- [ ] .dockerignore mencakup test, coverage, .git, .env\*.

- [ ] Image tag immutable (commit SHA atau semver), tidak :latest.

- [ ] Liveness ringan (/healthz), readiness cek dependency (/readyz); keduanya wired di Deployment.

- [ ] terminationGracePeriodSeconds ≥ worst-case shutdown time aplikasi (termasuk worker).

- [ ] app.close() di-call di handler SIGTERM; enableShutdownHooks() aktif.

- [ ] Resource request & limit di-set, bukan unbounded.

- [ ] HPA aktif untuk service utama; worker scale by queue depth (KEDA) kalau aplikabel.

- [ ] Migration jalan di pipeline atau K8s Job, sebelum rollout.

## Common Pitfalls NestJS + Fastify + Drizzle

Daftar bug & footgun yang sering muncul di kombinasi stack ini. Bukan teori — ini pelajaran berbiaya.

### 1. Lupa '0.0.0.0' di app.listen()

**await** app**.listen**(3000)**;** *// bind ke localhost di Fastify — container tidak bisa diakses dari luar pod*\
**await** app**.listen**(3000**,** '0.0.0.0')**;** *// benar*

Gejala: K8s liveness fail di pod, lokal jalan. Selalu eksplisit '0.0.0.0'.

### 2. @Res() reply: FastifyReply mematikan pipeline NestJS

Begitu Anda menyentuh reply langsung (reply.send(...), reply.code(...)), NestJS interceptor (logging, transform, audit) tidak jalan. Gunakan return value handler.

### 3. Fastify hook async lupa done atau lupa return

fastify**.addHook**('preHandler'**,** **async** (req**,** reply) **=\>** {\
**await** **doSomething**()**;**\
*// lupa return → handler berikutnya tetap jalan, bisa double-process*\
})**;**

Async hook Fastify: kalau bukan async, panggil done(err?). Kalau async, return promise — jangan campur.

### 4. Drizzle prepared statement di-recreate setiap request

*// jelek — query plan cache tidak terpakai*\
**const** u **=** **await** **this.**db**.select**()**.from**(users)**.where**(**eq**(users**.**id**,** id))**;**

Untuk query yang sangat hot, pakai prepare:

**private** **readonly** findByIdQ **=** **this.**db\
**.select**()**.from**(users)**.where**(**eq**(users**.**id**,** sql**.placeholder**('id')))**.prepare**('findUserById')**;**\
\
**async** **findById**(id**:** string) {\
**return** (**await** **this.**findByIdQ**.execute**({ id }))\[0\] **??** **null;**\
}

Trade-off: prepared statement perlu connection sticky pattern (atau pgbouncer mode session/transaction). Pakai untuk yang benar-benar hot.

### 5. Drizzle db.execute(sql\\\${userInput}\`)\` membuka SQL injection

Drizzle sql\\\` interpolation otomatis parameterized — **kalau Anda pakai placeholder tagged template**. Jangan string concat:

*// ❌ rentan*\
**await** db**.execute**(sql**.raw**(\`SELECT \* FROM users WHERE email = '**\${**email**}**'\`))**;**\
\
*// ✅ parameterized*\
**await** db**.execute**(**sql**\`SELECT \* FROM users WHERE email = **\${**email**}**\`)**;**

sql.raw() adalah escape hatch untuk DDL/identifier — **bukan** untuk user input.

### 6. BullMQ worker tanpa concurrency limit menghabiskan koneksi DB

Default concurrency BullMQ Worker = 1 (NestJS @Processor juga default 1 kalau tidak di-set). Tapi pernah ada yang set ke 100 untuk “speed” — pool DB max=20, worker ambil 100 job paralel, deadlock. Cocokkan concurrency dengan kapasitas resource downstream.

### 7. BullMQ tanpa removeOnComplete → Redis penuh

Default lama BullMQ menyimpan semua completed job. Setelah berbulan-bulan, Redis pakai gigabyte. Selalu set removeOnComplete: { count: ... } (atau age: ...).

### 8. Circular dependency antar module

UsersModule import OrdersModule, OrdersModule import UsersModule. Quick fix: forwardRef(). Real fix: ekstrak shared concept (mis. UserEventsModule atau interface token) ke modul ketiga.

### 9. @Injectable() lupa di service

Nest can't resolve dependencies of.... Lupa @Injectable() decorator di class — DI container tidak tahu cara instantiate.

### 10. Async onModuleInit yang lupa di-await

**async** **onModuleInit**() {\
**this.warmupCache**()**;** *// tanpa await — race*\
}

Atau lebih buruk, lempar exception unhandled di async — Nest tetap startup, tapi state setengah jalan. Selalu await dan handle error.

### 11. Request-scoped provider disuntik ke singleton

@**Injectable**({ scope**:** Scope**.**REQUEST })\
**class** RequestContext {}\
\
@**Injectable**() *// SINGLETON*\
**class** CacheService {\
**constructor**(**private** **readonly** ctx**:** RequestContext) {} *// ❌ poisoning lifetime*\
}

NestJS akan upgrade CacheService jadi request-scoped (durable hosts pun rumit) — performa drop drastis. Aturan: jangan inject narrow-scope ke broad-scope.

### 12. ZodValidationPipe global tapi handler pakai DTO non-zod

Pipe dipasang global, tapi handler pakai class biasa tanpa zod schema. Pipe diam — tidak validasi. Convensikan: semua DTO extends createZodDto(...).

### 13. Decorator order salah

@**Roles**('admin') *// ❌ urutan ini di NestJS terbaru tidak masalah, tapi kebiasaan baik:*\
@**UseGuards**(RolesGuard)\
@**Get**()

Konvensikan urutan: @UseGuards → @Roles → method decorator (@Get/@Post). Konsisten supaya reviewer cepat scan.

### 14. Lupa register pipe/filter/interceptor di e2e test

E2E test pakai Test.createTestingModule({ imports: \[AppModule\] }) tapi lupa useGlobalPipes/useGlobalFilters yang di main.ts. Test pass, prod gagal validasi atau error format. Solusi: pindahkan registrasi ke AppModule provider via APP_PIPE, APP_FILTER, APP_INTERCEPTOR, APP_GUARD — sekali wire, jalan di prod dan e2e.

### 15. ConfigService.get('foo') tanpa generic atau getOrThrow

**const** url **=** **this.**config**.get**('database.url')**;** *// type: any \| undefined*

Pakai get\<T\>('database.url', { infer: true }) atau getOrThrow. Type aman, fail-fast kalau missing.

### 16. Lupa app.enableShutdownHooks()

K8s SIGTERM → proses langsung mati, koneksi DB tidak di-close, BullMQ worker tidak close. State inkonsisten saat scale-down. Wajib aktif.

### 17. throw new Error('not found') bukan HttpException

Nest exception filter default tidak tahu handle Error — dijadikan 500. Pakai NotFoundException, BadRequestException, dst, atau HttpException custom.

### 18. Test pakai imports: \[AppModule\] untuk unit test

Bootstrap full app butuh DB, Redis, sekian detik per test. Itu integration/e2e, bukan unit. Untuk unit, eksplisit list provider dengan mock.

### 19. OTel tracing.ts di-import bukan sebagai file pertama

import { NestFactory } from '@nestjs/core'**;**\
import './observability/tracing'**;** *// ❌ terlambat — modul Nest sudah load*

Side-effect tracing harus jalan **sebelum** modul lain. import './observability/tracing' di paling atas main.ts (dan worker.ts).

### 20. Dual-write pino logger + console.log

console.log di service produksi keluar di stderr text-mode, di-grep tidak match dengan log lain. Banned. Inject PinoLogger selalu.

## Tooling Stack Rekomendasi

Daftar tooling yang dipakai konsisten antar project. Penyimpangan boleh, tapi dengan justifikasi.

| Kategori | Pilihan | Versi minimum | Alasan |
|----|----|----|----|
| Runtime | Node.js | 20 LTS / 22 LTS | LTS support, V8 modern, native fetch |
| Package manager | pnpm | 9.x | Cepat, hemat disk, strict dependency hoisting |
| Linter + Formatter | **Biome** | 1.8+ | Single binary, ~25× ESLint, format + lint terintegrasi |
| (Alternatif legacy) | ESLint + Prettier | — | Hanya kalau project lama, atau plugin yang Biome belum dukung |
| Build / TS compiler | SWC (via NestJS CLI) | terbaru | 20× lebih cepat dari tsc untuk transpile |
| Type-check | tsc --noEmit | TS 5.x | Type-check terpisah dari build |
| Test runner | **Vitest** | 1.x+ | ESM native, watch cepat, kompatibel Jest |
| HTTP test | Fastify inject() | (built-in) | Lebih cepat dari supertest TCP |
| Container test | Testcontainers | 10.x | DB nyata, fresh per suite |
| ORM + Migration | Drizzle ORM + drizzle-kit | terbaru | Type-safe SQL, schema-first, migration first-class |
| DB driver | pg (node-postgres) | 8.x | Pool dewasa, OTel instrumentation matang |
| Queue | BullMQ + @nestjs/bullmq | terbaru | Retry, scheduled, rate-limit, ekosistem matang |
| Cache client | cache-manager v5 + @keyv/redis | terbaru | Async, type-aman, multi-store |
| Logger | nestjs-pino + pino | 4.x / 9.x | JSON, integrasi req-id Fastify |
| Telemetry | OpenTelemetry SDK + auto-instrumentation | terbaru | Vendor-neutral, single source untuk log/metric/trace |
| Auth | @nestjs/passport + passport-jwt | terbaru | Native NestJS |
| Password hash | argon2 (libsodium-based) | terbaru | Adaptive, OWASP-recommended |
| Validation | zod + nestjs-zod | terbaru | Single source dengan validasi config & DTO |
| API docs | @nestjs/swagger + nestjs-zod patch | terbaru | Auto-generated, sinkron dengan kode |

### Kenapa Biome (di atas ESLint + Prettier)

- Satu tool: biome check --write lint + format dalam satu pass.

- Kecepatan: 20–25× lebih cepat di benchmark project menengah.

- Konfigurasi minimal: biome.json ringkas.

- Trade-off: ekosistem rules lebih kecil dari ESLint. Kalau Anda butuh plugin spesifik (mis. eslint-plugin-import untuk ordering kompleks), tetap pakai ESLint. Untuk 80% kasus, Biome cukup.

**//** **biome.json** **(template** **minimal)**\
**{**\
"\$schema"**:** "https://biomejs.dev/schemas/1.8.0/schema.json"**,**\
"organizeImports"**:** **{** "enabled"**:** **true** **},**\
"linter"**:** **{**\
"enabled"**:** **true,**\
"rules"**:** **{**\
"recommended"**:** **true,**\
"style"**:** **{** "noNonNullAssertion"**:** "warn"**,** "useConst"**:** "error" **},**\
"suspicious"**:** **{** "noExplicitAny"**:** "warn" **}**\
**}**\
**},**\
"formatter"**:** **{**\
"enabled"**:** **true,**\
"indentStyle"**:** "space"**,**\
"indentWidth"**:** 2**,**\
"lineWidth"**:** 100\
**}**\
**}**

### CI integration

*\# .github/workflows/ci.yml (potongan)*\
**-** **run:** pnpm install --frozen-lockfile\
**-** **run:** pnpm biome check\
**-** **run:** pnpm tsc --noEmit\
**-** **run:** pnpm test:cov\
**-** **run:** pnpm drizzle-kit check\
**-** **run:** pnpm build

## Lampiran A — Code Review Checklist

Pakai ini sebagai pengingat saat review PR. Sebagian besar baris di sini referensi ke section spesifik di dokumen — kalau ada yang perlu argumen lebih panjang, link section.

### Arsitektur & Module

- [ ] PR mengubah/menambah satu bounded context, bukan banyak sekaligus.

- [ ] Module yang diubah hanya export apa yang module lain butuhkan.

- [ ] Tidak ada forwardRef() baru tanpa justifikasi.

- [ ] Tidak ada @Global() baru di module business.

- [ ] Service tidak meng-import Drizzle/db langsung; lewat repository.

- [ ] Kalau ada infrastructure baru (Redis cluster, vendor SDK), ada module Infrastructure\* dengan lifecycle hook bersih.

### API

- [ ] Route di-version (/v1/...).

- [ ] DTO pakai zod (createZodDto); tidak ada validasi manual di service.

- [ ] Response dibungkus @ZodSerializerDto; tidak ada Drizzle row bocor.

- [ ] HTTP status code sesuai (201 untuk create, 204 untuk no-content, 409 untuk conflict).

- [ ] Pagination cursor untuk list yang bisa tumbuh.

- [ ] Error mengikuti format global (RFC 7807).

- [ ] Tidak ada @Res() di handler.

- [ ] Idempotency-Key untuk endpoint state-changing yang re-tryable.

- [ ] Swagger ter-update otomatis (decorator @ApiTags/@ApiOperation kalau perlu).

### Database (Drizzle)

- [ ] Schema di-update di infrastructure/database/schema/\*.ts.

- [ ] Migration di-generate (drizzle-kit generate) dan di-commit di PR yang sama.

- [ ] File migration di-review — tidak ada DROP/RENAME tak diharapkan.

- [ ] Index untuk query baru di endpoint hot di-define di schema.

- [ ] Type domain pakai \$inferSelect / \$inferInsert, bukan ditulis ulang.

- [ ] Transaction yang cross-repository di-orchestrate di service, propagasi tx.

- [ ] Tidak ada db.execute(sql.raw(...)) untuk query bisnis.

- [ ] Perubahan struktural pada tabel besar mengikuti expand-contract.

### Security

- [ ] Endpoint baru di-cover JwtAuthGuard (atau eksplisit @Public() dengan alasan).

- [ ] RBAC di-apply untuk role coarse; ownership check di service untuk per-user.

- [ ] Input divalidasi di pipe; tidak ada user input langsung ke sql\\\`.

- [ ] Tidak ada PII di log; field sensitif di-redact pino.

- [ ] Operasi sensitif (auth, role, financial) punya audit log.

- [ ] Secret tidak hard-coded; via env + Secret store.

- [ ] Dependency baru tidak punya CVE high/critical (pnpm audit).

### Testing

- [ ] Logic baru punya unit test dengan repository di-mock.

- [ ] Repository baru/ubah punya integration test (Testcontainers).

- [ ] Endpoint baru punya minimal e2e smoke test.

- [ ] Bug-fix disertai regression test.

- [ ] Coverage tidak turun di bawah threshold (80%).

- [ ] Tidak ada imports: \[AppModule\] di unit test.

- [ ] Side-effect non-deterministic (waktu, random) di-mock via injectable.

### Observability

- [ ] Log line baru pakai structured object, bukan string concat.

- [ ] Field sensitif tidak di-log.

- [ ] Milestone bisnis baru punya custom metric (kalau aplikabel).

- [ ] Span manual untuk operasi bisnis mahal (kalau aplikabel).

- [ ] Health check ter-update kalau dependency baru ditambahkan ke /readyz.

### Background Jobs

- [ ] Job baru idempotent (jobId natural atau idempotency token + cek consumer).

- [ ] Concurrency limit eksplisit; cocok dengan kapasitas downstream.

- [ ] removeOnComplete / removeOnFail di-set.

- [ ] Failed job termonitor (alert kalau melewati threshold).

- [ ] Worker baru terdaftar di WorkerModule, bukan AppModule.

### Containerization & Deployment

- [ ] Dockerfile tidak menambah dependency runtime tak perlu.

- [ ] Image tag di pipeline = commit SHA atau semver, bukan :latest.

- [ ] Resource request/limit baru sesuai profil observasi.

- [ ] Probe wiring tidak diubah tanpa diskusi (liveness ringan, readiness cek).

- [ ] terminationGracePeriodSeconds cukup untuk shutdown.

### Code Quality

- [ ] biome check lulus tanpa warning baru.

- [ ] tsc --noEmit lulus.

- [ ] Tidak ada console.log, // TODO tanpa link issue, any tak terjustifikasi.

- [ ] Nama (variable, fungsi, class) menjelaskan maksud, bukan singkatan kriptik.

- [ ] Komentar menjelaskan **kenapa**, bukan **apa** — kode harusnya menjelaskan apa.

- [ ] Tidak ada copy-paste antar method (\>5 baris yang sama → ekstrak).

## Lampiran B — Migration Guide v1.0 → v2.0

Project lama yang masih di Express+Prisma — panduan singkat migrasi ke Fastify+Drizzle. Ini bukan langkah mekanis; ini garis besar.

### Step 1 — Switch HTTP adapter Express → Fastify

1.  Tambah dependency: @nestjs/platform-fastify, fastify, @fastify/helmet, @fastify/cors, @fastify/compress.

2.  Di main.ts: ganti NestExpressApplication → NestFastifyApplication, ExpressAdapter → FastifyAdapter.

3.  Audit kode yang menyentuh Request/Response Express langsung. Ganti import { Request } from 'express' → import { FastifyRequest } from 'fastify'. Property berbeda di beberapa tempat (mis. req.session butuh plugin Fastify session terpisah).

4.  Middleware Express berbasis (req, res, next) tidak kompatibel langsung dengan Fastify. Konvert ke NestJS interceptor/guard, atau ke Fastify hook.

5.  Helmet/CORS/compress: pakai versi Fastify (@fastify/helmet bukan helmet).

6.  Test E2E: supertest(app.getHttpServer()) masih jalan, tapi prefer app.inject(...) Fastify untuk speed.

Setelah switch, jalankan e2e test. Yang sering rusak: response yang pakai @Res() Express, file upload (Fastify pakai @fastify/multipart bukan multer).

### Step 2 — Switch ORM Prisma → Drizzle

Ini lebih invasive. Strategi: per-module, bukan big-bang.

1.  Tambah drizzle-orm, drizzle-kit, pg. **Jangan hapus Prisma dulu.**

2.  Buat src/infrastructure/database/schema/ dan tulis schema Drizzle yang **mirror** Prisma schema. drizzle-kit pull dari DB ada (drizzle-kit introspect) — pakai itu sebagai starting point.

3.  Buat DrizzleService dan DrizzleModule (lihat Pilar 3). Run di parallel dengan PrismaService lama.

4.  Per module: rewrite repository pakai Drizzle. Service tidak berubah (kalau v1.0 sudah pakai repository; kalau service inject Prisma langsung, refactor dulu untuk pakai repository).

5.  Test integration repository baru dengan Testcontainers, pastikan parity.

6.  Switch service pakai repository baru. Hapus repository Prisma. Module per module.

7.  Setelah semua module switch, hapus Prisma dependency dan prisma/schema.prisma. **Jangan hapus migration Prisma yang sudah ter-apply** — start drizzle-kit generate baseline dari schema saat ini (introspect DB nyata, hasilkan migration “0000_init” sesuai state aktual).

### Step 3 — Validation class-validator → zod

Lebih ringan. Per DTO:

1.  Tambah nestjs-zod, zod.

2.  Convert class-validator decorator ke zod schema:

- *// sebelum*\
  **class** CreateUserDto { @**IsEmail**() email**:** string**;** @**MinLength**(12) password**:** string**;** }\
  *// sesudah*\
  **const** Schema **=** z**.object**({ email**:** z**.string**()**.email**()**,** password**:** z**.string**()**.min**(12) })**;**\
  **class** CreateUserDto **extends** **createZodDto**(Schema) {}

3.  Ganti ValidationPipe global ke ZodValidationPipe.

4.  Patch swagger: patchNestJsSwagger() setelah import.

class-validator dan zod boleh coexist sementara — ZodValidationPipe tahu cara skip non-zod DTO.

### Step 4 — Test Jest → Vitest

Hampir 1:1. Diff utama:

- jest.fn() → vi.fn(), jest.mock(...) → vi.mock(...).

- Config: ganti jest.config.ts → vitest.config.ts.

- --watch Jest → built-in Vitest.

Run side-by-side dulu kalau ragu — pnpm test (Vitest) dan pnpm test:legacy (Jest), pindahkan suite per suite.

### Step 5 — Linter ESLint+Prettier → Biome

1.  Tambah Biome. Buat biome.json.

2.  Run biome check --write di repo. Diff besar pertama → review, commit.

3.  Hapus ESLint, Prettier, plugin terkait dari package.json dan CI.

4.  Editor extension: install Biome VSCode extension.

Migrasi ini ringan; lakukan di PR tersendiri, bukan dicampur dengan migrasi stack lain.

*— Akhir dokumen —*

*Dokumen ini hidup. Punya saran perubahan? Buka PR ke repo dokumen atau angkat di review tim engineering.*
