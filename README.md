# 클랙 CLI

클랙 계정의 프로필·상품·게시글·크리에이터 채널을 터미널에서 관리한다. 앱과 같은 API·소유권·본인인증·계정 제한을 적용한다. Node.js 20 이상이 필요하다.

```sh
npm i -g @clack-platform/cli
clack --help
```

설치 없이 한 번만 실행하려면 `npx @clack-platform/cli`를 쓴다. 소스에서 직접 실행하려면 이 저장소 루트에서 `pnpm install --frozen-lockfile && pnpm check && node dist/cli.js --help`를 쓴다.

> 외부 도구 연결은 단계적으로 공개 중이며 현재 운영 환경에서는 사용할 수 없다. 테스트 환경 참여자는 `clack config set env dev` 실행 후 로그인한다.

## 연결

```sh
clack login --scopes profile:read,product:read,product:write
clack whoami --json
clack logout
```

`login`이 표시한 코드를 앱 **마이페이지 → 계정 → 내 정보 수정하기 → 외부 도구 연결 → 코드로 승인**에서 입력한다. 요청한 권한을 확인하고 승인하면 CLI에 연결된다. 기본 요청 권한은 `profile:read` 하나다. `profile`, `product`, `content`, `creator-content`, `skill`, `platform`, `custom-page` 묶음은 각각 읽기·쓰기를 모두 요청한다(`creator-content:publish`, `skill:publish`, `custom-page:publish`는 별도 명시가 필요하다). 명령별 필요 권한은 각 명령의 `--help`와 아래 절의 권한 표에 적혀 있다. `platform`은 내 콘텐츠의 서버 키·공유 문서 관리 전용 권한이다(아래 "플랫폼 전용 PAT 도구" 절 참고). 소셜 로그인 사용자도 앱에서 승인할 수 있다. 웹 승인 화면은 별도 후속 단계이므로 현재는 앱 승인을 사용한다.

수동 발급한 토큰은 `clack login --token`의 숨김 프롬프트에 붙여 넣는다. 비대화형 실행에서는 이 명령의 표준 입력으로 전달할 수 있다. `--token <값>`도 지원하지만 셸 기록을 피하려면 프롬프트나 `CLACK_TOKEN` 환경변수를 사용한다. 토큰 원문은 정상 결과·오류·상세 로그에 출력하지 않는다.

승인 코드·주소는 표준 오류에, 최종 결과는 표준 출력에 기록한다. `--json`에서는 QR과 브라우저 자동 열기를 생략하며, `--no-qr`로 QR만 따로 끌 수 있다(에이전트·비대화형 환경에 적합). 승인이 거부·만료되거나 토큰 교부 응답을 받지 못하면 자동으로 새 연결을 만들지 않는다. 앱에서 기존 연결을 확인한 후 다시 로그인한다.

```sh
clack login --env dev --scopes profile,product,content --no-browser
clack token list --json
clack token revoke 123 --yes
```

### 승인 대기 중 실행이 끊기는 경우(에이전트용)

`login`은 코드를 발급한 즉시(폴링을 시작하기 전에) 그 요청을 자격 저장소 옆에 0600 권한으로 저장해 둔다. 그래서 승인을 기다리는 도중에 프로세스가 끝나도(에이전트가 턴을 종료하는 경우 등) 승인 자체는 유실되지 않는다 — 다음 실행에서 `clack login --resume`으로 같은 코드를 이어서 기다리면 된다.

```sh
clack login --no-wait --json   # 코드만 발급하고 즉시 반환 (user_code·주소·만료 시각을 JSON으로 출력)
# … 사용자가 앱에서 승인할 시간을 준다(턴 종료 등) …
clack login --resume           # 같은 요청을 이어서 기다리다가 승인되면 저장한다
```

`--no-wait` 없이 그냥 `clack login`을 실행했다가 대기 중 중단된 경우에도 `clack login --resume`으로 이어받을 수 있다. `--resume`은 새 코드를 발급하지 않으며, 저장된 요청이 이미 만료·거부·소비됐으면(`EXPIRED_TOKEN`·`ACCESS_DENIED`·`DEVICE_CODE_CONSUMED`) 그 사실을 분명한 오류 코드로 알리고 자동으로 새 요청을 만들지 않는다 — 이때는 `clack login`을 다시 실행한다. 저장된 요청이 없으면 `DEVICE_REQUEST_NOT_FOUND`, 발급 당시와 다른 `--env`·`--base-url`로 재개를 시도하면 `DEVICE_REQUEST_ORIGIN_MISMATCH`를 반환한다(둘 다 요청을 지우지 않으므로 `--env`를 바로잡아 다시 시도할 수 있다). `--resume`은 `--token`과 함께 쓸 수 없다.

```sh
clack login --resume --env dev   # 발급 당시와 같은 환경이어야 한다. 다르면 DEVICE_REQUEST_ORIGIN_MISMATCH
```

## 주요 명령

세부 필드·선택지는 각 명령의 `--help`에서 확인한다.

| 대상 | 명령 |
|---|---|
| 연결 | `login`, `logout`, `whoami`, `doctor`, `token list`, `token revoke` |
| 프로필 | `me get`, `me update`, `me seller-intro set`, `me password change` |
| 알림·배송지 | `me notifications set`, `me email send/verify/set`, `me address list/add/update/delete/default` |
| 상품 | `product list/get/create/update/status/bump/hide/unhide/delete` |
| 상품 입력 참고 | `product types/categories/shipping-methods` |
| 글 | `post list/get/create/update/delete/link-products` |
| 댓글 | `comment list/add/delete` |
| 크리에이터 채널 | `channel get/create/update`, `channel post list/get/create/update/delete`, `channel series list/create/update/delete` |
| 이미지 | `upload <파일...>` |
| 설정 | `config get`, `config set <키> <값>` |
| HTML 콘텐츠 | `content config/list/status/create/update/upload/complete/info-version/preview/submit/withdraw/publish/unpublish` |
| 에이전트 연결 | `mcp config`, `skills` |
| 스킬 패키지·관리 | `skill validate`, `skill pack`, `skill editor dev`, `skill push`, `skill complete`, `skill submit`, `skill list`, `skill get`, `skill form`, `skill status`, `skill cancel`, `skill release`, `skill deprecate` |
| 콘텐츠 서버 키(platform:read/write) | `content server-keys list/revoke` (발급·회전은 크리에이터 센터 전용) |
| 공유 문서 관리(platform:read/write) | `content shared collections/list/get/hide/delete` |
| 플랫폼 서버 키 데이터 | `platform usage`, `platform data get`, `platform data list`, `platform data leaderboard`, `platform data put`, `platform data patch`, `platform data delete` |
| 플랫폼 MCP 도구 | `mcp config --platform`, `mcp serve-platform` |

```sh
clack product list --status selling --all --json
clack product create -f product.json --dry-run --json
clack product create -f product.json --json
clack product update 123 --price 12000
clack product status 123 sold --yes
clack product delete 123 --yes
clack post create --feed --content '새 글' --images ./photo.png
clack channel post create --from-markdown draft.md --status draft
```

상품 생성에는 `type`, `images`, `name`, `category`, `price`, `description`이 필요하다. `product categories`의 저장용 카테고리를 사용한다. 이미지 경로는 자동 업로드하며 JSON 파일 속 상대 경로는 해당 파일을 기준으로 해석한다. 거래 유형은 `sell`, `buy`, `groupbuy`, `randombox`, `commission`이다. 언어와 통화는 서버의 기존 규칙을 따른다.

`product create -f items.json`에 배열을 전달하면 항목별 결과를 반환한다. `--report report.json`으로 저장하고 `--resume report.json`으로 실패 항목을 재개한다. 보고서에는 등록 입력이 포함되므로 개인정보 취급에 주의한다. 서버 응답이 유실된 변경은 앱에서 반영 여부를 확인해야 한다.

배치 중 일부가 실패하면 종료 코드 6과 `ok:false`, `code:BATCH_FAILED`를 반환하고 `data`에 전체 보고서를 포함한다. 이미 성공한 항목과 `OUTCOME_UNKNOWN` 항목은 자동 재개하지 않는다. 보고서는 생성 요청 직전부터 원자적으로 갱신하여 프로세스 중단 후의 중복 등록도 방지한다.

삭제·거래완료 전에는 대화형 확인을 받는다. 비대화형 실행에서는 `--yes`가 필요하다. `--dry-run`은 입력·로컬 이미지 검증과 미리보기만 수행하며 서버 변경이나 업로드를 실행하지 않는다. 보드 유형이나 기존 콘텐츠를 확인하는 읽기 요청은 할 수 있다.

마크다운은 문단·강조·링크·구분선·이미지를 채널 블록으로 변환한다. 제목·목록·인용·코드 등 지원하지 않는 서식은 문단으로 변환하고 안내한다. 로컬 이미지는 업로드하며 원격 이미지는 허용된 CDN에서만 처리한다.

## 설정과 출력

기본 설정은 macOS/Linux의 `~/.config/clack/`, Windows의 `%APPDATA%\\clack\\`에 저장한다. `XDG_CONFIG_HOME`과 별도 격리용 `CLACK_CONFIG_DIR`도 지원한다. 자격 파일 `credentials.json`은 POSIX에서 `0600`, 폴더는 `0700`이다. 프로필마다 연결한 API 원점을 함께 보관하며 다른 주소에 저장된 토큰을 자동 전송하지 않는다.

- 프로필: `--profile` → `CLACK_PROFILE` → 기본 프로필(`default`) 순서. `--env`는 프로필을 바꾸지 않는다 — 어떤 프로필이든 그 프로필이 가리키는 환경(주소)만 고른다.
- API 주소: `--base-url` → `CLACK_API_BASE` → (`--env`가 있으면 그 환경의 기본 주소, 없으면 프로필에 저장된 주소) → 프로필의 `env` 설정(없으면 운영) 기본 주소 순서.
- 토큰: `CLACK_TOKEN` → 해당 프로필의 저장된 토큰 순서.
- 설정 키: `env`, `base_url`, `time`(`local`/`utc`), `lang`(`ko`/`en`), `output`(`human`/`json`).

`config set env dev` 후 로그인하거나 `login --env dev`로 바로 연결하거나(또는 둘을 섞어도) 같은 기본 프로필의 같은 dev 자격을 쓴다. 이후 명령에 `--env dev`를 붙이거나 떼도 결과가 바뀌지 않는다. 명시적으로 다른 환경(예: `--env prod`)을 고르면 그 환경을 따르며, 그 환경의 자격이 없으면 다시 로그인해야 한다. 여러 계정·환경을 동시에 쓰려면 `--profile <이름>`으로 별도 프로필을 만든다. `config set env dev`처럼 환경을 변경하면 이전에 저장한 `base_url`을 지우고 새 환경의 기본 주소를 사용한다. 기존 토큰의 원점이 다르면 다시 로그인해야 한다. (이전 개발 빌드에서 기본 프로필 이름으로 쓰던 `prod`도 그대로 이어서 인식한다.) `token list --cursor <값>`으로 50개 이후의 연결도 조회할 수 있다.

CLI 안내는 한국어다. `lang`은 API 콘텐츠 언어에 사용한다. `--verbose`는 메서드·경로·시간 계약만 표준 오류로 표시한다. `doctor`는 현재 연결·권한·만료와 서버 메타 API의 한도·읽기/쓰기·MCP·디바이스 연결 상태를 검사한다. 메타 조회 실패는 오류로 반환한다.

`--json` 성공 결과는 `{ok:true,data,pagination?,time_contract}`, 실패 결과는 `{ok:false,status,code,message,retry_after?}`다. 시간 문자열은 API 원문과 `time_contract`를 함께 유지한다. 사람용 출력은 알려진 시각 필드에 중앙 파서를 적용하며 `--time utc`로 실제 UTC를 표시할 수 있다. 생년월일과 본문은 시간으로 변환하지 않는다. 기본값(`--time local`)은 실행 환경의 로캘·타임존과 무관하게 `YYYY-MM-DD HH:MM KST` 고정 형식으로 표시한다(클랙 서비스는 항상 한국 시간 기준이다).

| 종료 코드 | 의미 |
|---|---|
| 0 | 성공 |
| 1 | 네트워크·서버·내부 오류 |
| 3 | 로그인·토큰 문제 |
| 4 | 권한·본인인증·계정 제한 |
| 5 | 대상 없음 |
| 6 | 입력·충돌·확인 필요 또는 배치 일부 실패 |
| 7 | 요청 한도 |
| 8 | 외부 도구 기능 중단(관리자가 끈 상태, 또는 연결한 서버에 아직 배포되지 않음) |

`login`(디바이스 코드 발급)·`doctor` 등 첫 연결 경로에서 연결한 서버(API 원점)가 외부 도구 연결 자체를 아직 지원하지 않으면(전용 라우트가 없어 404, 또는 디바이스 코드 발급이 이전 시간 계약만 지원해 406) `code:USER_API_UNAVAILABLE`과 종료 코드 8을 반환한다. 운영(prod)은 아직 배포 전이므로 흔히 이 상황을 만난다 — `clack config set env dev`로 전환한 뒤 다시 로그인한다. 상품·게시글 등 일반 리소스의 404나 다른 요청의 406은 이 매핑의 영향을 받지 않는다.

채팅·주문·결제·탈퇴·계좌·본인인증 실행과 타인 콘텐츠 반응은 제공하지 않는다. 본인인증이 필요하면 앱에서 완료한다. 댓글 수정 API가 없으므로 댓글은 작성·삭제만 제공한다.

## MCP와 에이전트 스킬

```sh
clack mcp config --print
clack mcp config --claude
clack mcp config --codex
clack mcp config --json
clack skills --json
```

`mcp config`는 선택한 API 원점의 `/v4/mcp`와 `CLACK_TOKEN` 환경변수 참조를 출력한다. 로그인이나 네트워크 접근 없이 사용할 수 있고 자격 파일·에이전트 설정을 읽거나 변경하지 않는다. 기본값과 `--print`는 Claude Code의 `.mcp.json` 조각, `--claude`는 POSIX 셸에서 실행할 프로젝트 등록 명령, `--codex`는 Codex의 `config.toml` 조각이다. `--json`은 공통 성공 봉투의 `data`에 두 클라이언트의 설정·등록 명령·안내를 모두 담는다. 사람용 안내는 표준 오류에 기록한다. 기존 설정에 해당 `clack` 항목만 병합하고 다른 서버 항목을 보존한다.

앱에서 작업에 필요한 권한으로 개인 액세스 토큰을 발급하고 에이전트를 실행하는 환경의 `CLACK_TOKEN`에 안전하게 넣는다. 토큰을 대화창·명령 인자·공유 설정 파일에 붙여 넣지 않는다. CLI에 저장된 디바이스 로그인 토큰은 MCP로 자동 전달되지 않는다. CLI 프로필을 바꿔도 이미 등록한 MCP 주소는 그대로이므로 주소와 토큰의 계정을 확인한다. 이 서버는 PAT 인증을 사용하며 OAuth 로그인은 제공하지 않는다. 연결 후 `get_guide` → `whoami` → `get_meta`로 계정·권한·한도를 확인한다.

환경변수 참조 형식은 [Claude Code MCP 문서](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json)와 [Codex MCP 문서](https://developers.openai.com/codex/mcp/)를 따른다. 다른 클라이언트는 해당 제품의 Streamable HTTP·인증 헤더 지원을 확인한다.

원격 MCP는 프로필·상품·게시글·채널 도구 외에 스킬 목록·상세·업로드(`create_skill`→`request_skill_version_upload`→`complete_skill_version`)·심사 제출·공개(`submit_skill_version`, `release_skill_version`, `get_skill_version`), HTML 콘텐츠 정보 수정·정보만 새 버전(`update_creator_content`, `create_creator_info_version`), 승인된 HTML 콘텐츠 공개(`publish_creator_content`), 공유 문서 조회·숨김·삭제(`list_shared_documents`, `hide_shared_document`, `delete_shared_document` 등)도 제공한다. 각 도구는 해당 스코프(`skill:*`, `creator-content:publish`, `platform:read`/`platform:write`)를 가진 토큰에만 노출되며, 파괴적 도구는 `confirm:true` 전에는 미리보기만 반환한다. 원격 MCP는 로컬 파일을 읽지 못하므로 스킬 ZIP 전송은 `clack skill push` 또는 로컬 플랫폼 MCP의 `platform_skill_push`를 사용한다.

에이전트 스킬은 별도 공개 저장소 [clack-project/skills](https://github.com/clack-project/skills)에서 `npx skills add clack-project/skills`로 설치한다. 모두 10종으로, 일반 계정 관리용 6종(`clack-setup`·`clack-products`·`clack-content`·`clack-channel`·`clack-profile`·`clack-mcp`)과 크리에이터용 4종(`clack-creator-content`·`clack-page`·`clack-skill-package`·`clack-platform-data`)이다. 스킬에 필요한 CLI는 0.1.1 이상이다(`clack-mcp`는 CLI 없이도 쓸 수 있고, 설정 출력에 CLI를 쓸 때는 0.1.0 이상). `clack skills`는 설치를 실행하지 않고 안내만 출력한다. 스킬 목록과 스킬별 요구 CLI 버전도 함께 보여 준다. 스킬 하나만 선택 설치할 때는 `-s clack-products`, 여러 개는 `--skill clack-setup clack-creator-content clack-page`처럼 나열하고, 전역 설치에는 `-g`를 사용한다.

## 검증과 배포

```sh
pnpm check          # typecheck → 스키마 동기화 확인 → 테스트 → 빌드
npm pack --dry-run
```

`pnpm check`는 나란히 체크아웃한 클랙 모노레포가 있으면(`CLACK_MONOREPO_DIR`, 기본 `../clack`) MCP 입력 스키마 일치도 함께 확인하고, 없으면 건너뛴다. 배포 전 로컬에서 이 확인을 강제하려면 `pnpm check:release`를 쓴다. `scripts/sync-vendor-types.mjs [--check]`는 `src/vendor/` 아래 복사해 둔 클랙 공개 타입·계약 파일을 같은 방식으로 모노레포와 동기화한다.

GitHub Actions는 Linux·macOS·Windows × Node 20·22에서 `pnpm check`와 패키지 설치 스모크를 실행한다(`.github/workflows/ci.yml`). 배포는 `v0.1.0` 형태의 버전 태그를 push하면 `.github/workflows/publish.yml`이 태그와 `package.json` 버전 일치를 확인한 뒤 GitHub Actions의 OIDC 신뢰 게시로 npm에 공개한다.


## HTML 콘텐츠 개발 테스트

크리에이터 콘텐츠는 기존 게시글·포켓과 별도 권한을 사용합니다. 앱 확인·심사·공개 기능의 제공 여부는 환경마다 다르며 `clack content config`의 `app_preview_enabled`·`review_enabled`·`publication_enabled`로 확인합니다. CLI로 앱 확인 요건을 우회할 수 없습니다.

| 명령 | 필요한 PAT 권한 |
|---|---|
| `config` | 없음(로그인 불필요) |
| `list`, `status`, `preview` | `creator-content:read` |
| `create`, `update`, `upload`, `complete`, `info-version`, `withdraw` | `creator-content:write` |
| `submit` | `creator-content:write`와 `creator-content:publish` 모두 |
| `publish`, `unpublish` | `creator-content:publish` |

제출 순서는 `upload` → `preview`(같은 계정의 앱에서 열어 확인 완료) → `submit`입니다. 앱 확인 전에 제출하면 `PREVIEW_CONFIRMATION_REQUIRED`(409)가 반환됩니다.

```bash
clack login --env dev --scopes creator-content:read,creator-content:write,creator-content:publish
clack content config --env dev
clack content create --env dev --title "내 작품" --policy-version 2026-09-22
clack content upload --env dev <콘텐츠-UUID> ./index.html
clack content status --env dev <콘텐츠-UUID>
clack content preview --env dev <콘텐츠-UUID> <버전-UUID>
```

`content upload`는 최대 30 MiB의 HTML/ZIP을 체크섬과 함께 비공개 저장소에 전송합니다. 전송 후 완료 응답만 실패하면 출력된 `content complete` 명령으로 같은 업로드를 재처리할 수 있습니다. `--dry-run`은 파일·입력 검사만 수행합니다. `creator-content` 약식 scope는 읽기·쓰기만 요청하며 `submit`·`publish`·`unpublish`에 필요한 `creator-content:publish`는 명시적으로 요청해야 합니다. 정책 내용을 크리에이터 센터에서 확인한 뒤 `--policy-version`으로 동의한 버전을 지정하세요.

ZIP에 `clack.content.json` 또는 `.clack/`가 있으면 업로드 전에 선언·경로·크기와 프로필 파일 대응을 확인하고 표준 오류에 경고합니다. 선언이 없는 기존 정적 ZIP도 계속 업로드할 수 있습니다. 경고는 업로드를 막지 않으며 서버의 최종 검증·심사 결과를 대신하지 않습니다. 전송 없이 확인하려면 `content upload ... --dry-run`을 사용하세요.

`content update`는 제목·설명·종류·썸네일·메타데이터·태그를 서버 PATCH와 같은 규칙으로 수정합니다(`--title`, `--description`, `--kind`, `--thumbnail-id <썸네일 작업 ID|none>`, `--metadata-mode single|localized`, `--metadata-lang ko|en|none`, `--localized-metadata '<JSON>'|none`, `--tags 쉼표목록`). 지정한 필드만 바뀌고 `--tags`·`--localized-metadata`는 통째 교체됩니다. 제목은 비우면 「제목 없는 콘텐츠」로 표시됩니다. 썸네일 작업 ID는 `POST /v4/creator/thumbnails` 등으로 발급하며 CLI에는 썸네일 업로드 명령이 없어 보통 `none`(기본 이미지로 되돌리기)만 씁니다. 언어별 메타데이터·태그는 서버 게이트가 켜진 환경에서만 쓸 수 있습니다. 인트로 저장은 개인 액세스 토큰으로 할 수 없어 크리에이터 센터에서만 합니다.

`content info-version <콘텐츠-UUID> <버전-UUID>`는 승인·반려된 버전의 번들을 재사용해 바뀐 콘텐츠 정보만 담은 새 초안 버전을 만듭니다(새로 만들면 201, 이미 있던 초안이면 200이며 응답의 `created`로 구분). 새 버전은 앱 확인과 심사를 다시 받아야 합니다. 서버 게이트가 꺼진 환경에서는 `CONTENT_INFO_VERSION_DISABLED`(409)가 반환되며 `clack content config`의 `info_version.enabled`로 확인할 수 있습니다.

```bash
clack content update --env dev <콘텐츠-UUID> --title "새 제목" --tags 여행,사진
clack content info-version --env dev <콘텐츠-UUID> <버전-UUID>
```

심사는 승인됐지만 아직 공개하지 않은 버전(크리에이터 센터 등록·게시 중단 후 재공개 등)은 `creator-content:publish` 권한으로 공개합니다. 승인 이력·심사 해시·현재 계정과 권한을 공개 시점에 다시 검사합니다.

```bash
clack content publish --env dev <콘텐츠-UUID> <버전-UUID>
```

## 스킬 패키지 개발 검증

`clack.skill.json`과 `SKILL.md`가 있는 디렉터리 또는 ZIP을 검사합니다. 로컬 검증은 로그인 없이 실행할 수 있습니다. 서버 경로(`validate --remote`, `push` 등)는 현재 개발 환경에서 기능 플래그가 켜진 계정과 아래 표의 권한을 가진 개인 액세스 토큰이 필요합니다.

```sh
clack skill validate ./my-skill
clack skill validate ./my-skill.zip --remote --env dev
clack skill push ./my-skill --env dev
clack skill push ./my-skill --skill-id <스킬-UUID> --env dev
clack skill complete <스킬-UUID> <버전-UUID> --env dev
clack skill list --category character_chat --official true --env dev
clack skill list --all --env dev
clack skill get my-skill --env dev
clack skill form my-skill 1.0.0 --env dev
clack skill status <스킬-UUID> <버전-UUID> --env dev
clack skill submit <스킬-UUID> <버전-UUID> --env dev
clack skill cancel <스킬-UUID> <버전-UUID> --env dev
clack skill release <스킬-UUID> <버전-UUID> --visibility unlisted --env dev
clack skill deprecate <스킬-UUID> --env dev
```

`push`는 서버 사전 검증 후 새 스킬 또는 기존 스킬의 버전을 예약하고, 서명된 URL에 ZIP을 전송한 뒤 완료 처리합니다. 완료 응답만 실패하면 출력된 `skill complete` 명령으로 같은 버전을 재처리합니다. `--dry-run`은 서버를 변경하지 않습니다.

| 명령 | 필요한 PAT 권한 |
|---|---|
| `validate`(로컬) | 없음(로그인 불필요) |
| `list`, `get`, `form`, `status` | `skill:read` |
| `validate --remote`, `push`, `complete`, `cancel` | `skill:write` |
| `submit` | `skill:write`와 `skill:publish` 모두 |
| `release`, `deprecate` | `skill:publish` |

`clack login --scopes skill` 약식은 읽기·쓰기만 요청하므로 제출·게시·지원 종료에는 `skill:publish`를 추가해야 합니다. 변경 명령은 개인 액세스 토큰(PAT)만 사용합니다. `submit`은 서버에서 검증 완료 상태와 패키지 해시를 조회한 뒤 확인을 받고 심사를 요청합니다. `--dry-run`은 제출 요청 없이 상태만 확인합니다. `release`는 심사를 통과한 버전만 허용하고, `--visibility public`은 별도 라이브러리 등재 승인이 필요합니다. 심사 판정은 관리자 화면에서 처리합니다. `deprecate`는 스킬 전체를 지원 종료 상태로 바꾸며 되돌릴 수 없습니다. 확인 후에만 실행되고(비대화형은 `--yes` 필요), 새 설치·새 제작은 막히지만 기존 콘텐츠가 고정한 버전은 계속 동작합니다.

### 스킬 플러그인 정적 검사(plugin-static-v2)

`clack.skill.json`의 `authoring.plugin`으로 제작 화면 플러그인을 선언하면 서버가 번들을 구문 트리(JS·HTML·CSS)로 검사합니다. 위험 기능을 쓰지 않는다고 증명할 수 있는 코드만 통과하고, 판단할 수 없는 코드는 오류로 봅니다. 요약은 다음과 같고 크리에이터 센터 `/ko/creator/skills/help/plugin`에도 같은 안내가 있습니다. 메시지 예제·권한 동의·심사 준비를 포함한 상세 안내의 정본은 크리에이터 가이드 `/ko/guide/reference/templates/editor-plugins`(T09)와 실습 과정 `/ko/guide/courses/center-editor-plugin`(T05)입니다.

- 선언: `bundle`(진입 HTML)·`sha256`·`fields`·`permissions`·`purpose`. 권한은 `getFormSchema`·`getFormValues`·`setFormValues`·`listApprovedAssets`·`requestAssetUpload`만 있고, 권한·필드가 늘면 크리에이터에게 다시 동의를 받습니다.
- 번들: 파일 50개, 파일당 512 KiB, 전체 2 MiB, 코드 합계 512 KiB 이하. 형식은 html·js·mjs·css·json·png·jpg·webp·gif·woff·woff2만 허용합니다.
- 진입 HTML: CSP 메타를 한 번만 두고 `default-src 'none'`으로 시작합니다. `connect-src`는 `'none'`만, `script-src`·`style-src`는 `'self'` 또는 해시, `img-src`·`font-src`는 `'self'` 또는 `data:`만 씁니다. 인라인 스크립트·인라인 이벤트 속성·meta refresh·외부 URL 참조는 금지이고 `<link>`는 `rel="stylesheet"`만 허용합니다.
- 스크립트 금지: 동적 코드(`eval`·`Function`·`WebAssembly`), 네트워크(`fetch`·`XMLHttpRequest`·`WebSocket`·`EventSource`·`Worker`·`Image`), 저장소(`localStorage`·`sessionStorage`·`indexedDB`·쿠키), 페이지 이동(`location` 쓰기·`assign`·`replace`·`history`·`open`·`top`), `innerHTML` 같은 위험 DOM 쓰기, 계산된 멤버 접근(`obj[key]`), 전역 별칭(`self`·`globalThis`·`const w = window`), `Reflect`·`Proxy`·`constructor` 반사, `atob`·`escape`·이스케이프 문자열 난독화. `import`는 번들 안 상대 경로 `.js`·`.mjs`만 씁니다.
- 메시지: `postMessage` 대상은 `https://` 리터럴·받은 이벤트의 `origin`·fragment의 `clack-parent` 값만 허용하고 `'*'`는 금지입니다. 수신 시 `event.origin`·`event.source`를 확인하고 메시지에 `nonce`·`request_id`를 담습니다.
- 로드 토큰: iframe 주소의 실행 토큰은 300초 동안 유효하고 번들 안 상대 경로 자원도 같은 토큰으로 검사합니다. 센터는 만료 30초 전에 새 토큰으로 플러그인을 다시 엽니다. 필요한 자원은 첫 로드 때 불러오고, 상태는 `setFormValues`로 저장한 뒤 다시 열렸을 때 `getFormValues`로 이어 갑니다.
- 심사: 업로드는 구조 오류만 422 `SKILL_PLUGIN_INVALID`로 거부하고, 코드 판정은 줄 번호와 함께 심사 근거로 남깁니다. 관리자가 번들 소스를 직접 확인한 뒤 승인하며 플러그인과 결과 콘텐츠는 자동 공개되지 않습니다. 이전 규칙(v1)으로 검사된 대기 플러그인은 승인할 수 없으니(409 `PLUGIN_STATIC_CHECK_STALE`) 새 버전으로 다시 올립니다.


## 스킬 에디터(`authoring.editor`) 개발

스킬이 전체 화면 제작 UI(에디터)를 제공하는 스킬입니다. v1은 크리에이터 센터에서만 쓸 수 있어 `skill list`·`skill get` 결과에 `availability: "센터 전용"`으로 표시됩니다(서버가 `center_only`·`editor`를 내려줄 때).

- `clack skill validate [dir]`: 에디터 번들 구조·한도(파일 50개·파일 512 KiB·전체 2 MiB·코드 512 KiB)·번들 해시, `output.data` 스키마(`output-data.v1`: `pattern` 금지, `uniqueItems`는 스칼라 배열만), 예시 문서를 로컬에서 검사합니다. 지연 로드 의심(`loading="lazy"`·동적 `import()`·CSS `url()`)은 경고로만 알립니다. 에디터 코드의 구문 트리 정적 검사(`editor-static-v1`)와 심사는 서버 판정이 최종입니다.
- `clack skill pack [dir] [-o out.zip] [--write-manifest]`: ZIP을 만들면서 `authoring.editor.sha256`을 번들 해시로 채웁니다. `--write-manifest`는 채운 값을 디렉터리의 `clack.skill.json`에도 기록합니다. `skill push`도 같은 값을 채워 올립니다.
- `clack skill editor dev [--editor <dir>] [--document <json>] [--schema <json>]`: SDK의 모의 호스트로 `http://localhost:5170`에서 에디터를 열어 봅니다(로그인 불필요). SDK(`@clack/skill-editor-sdk`)는 `--sdk-dir`, `CLACK_SKILL_EDITOR_SDK_DIR`, 현재 디렉터리에서 설치된 패키지, `CLACK_MONOREPO_DIR/clack-skill-editor-sdk` 순서로 찾으며, SDK에서 `pnpm build`를 먼저 실행해야 합니다.

스킬 에디터 SDK는 아직 npm에 공개되지 않았고 CLI 패키지에도 들어 있지 않습니다. SDK 소스 디렉터리(클랙 내부 작업자는 내부 저장소 체크아웃의 `clack-skill-editor-sdk`)에서 한 번 빌드한 뒤 그 위치를 알려 줍니다.

```sh
cd <내부 저장소>/clack-skill-editor-sdk && pnpm install && pnpm build
clack skill editor dev --sdk-dir <내부 저장소>/clack-skill-editor-sdk --editor ./editor --schema ./output/data.schema.json --document ./examples/basic.json
# 또는 CLACK_MONOREPO_DIR=<내부 저장소> clack skill editor dev ...
```

## 플랫폼 전용 PAT 도구(서버 키·공유 문서·콘텐츠 공개)

`platform:read`·`platform:write` 스코프의 개인 액세스 토큰(PAT)으로 내 콘텐츠의 서버 키(`csk_`)를 조회·폐기하고, 이용자가 쓴 공유(shared) 문서를 조회·숨김·삭제합니다. `platform:read`는 조회, `platform:write`는 폐기·숨김·삭제입니다. 서버 키 발급·회전은 PAT보다 오래 사는 비밀값을 만들므로 크리에이터 센터 로그인 세션에서만 할 수 있고, `content server-keys issue`·`rotate`는 센터 안내만 출력합니다. 서버 키 원문은 센터의 발급·회전 응답에만 한 번 담깁니다.

```sh
clack login --env dev --scopes platform
clack content server-keys list --env dev <콘텐츠-UUID>
clack content server-keys revoke --env dev <콘텐츠-UUID> <키-ID> --yes
clack content shared collections --env dev <콘텐츠-UUID>
clack content shared list --env dev <콘텐츠-UUID> ranking
clack content shared get --env dev <콘텐츠-UUID> ranking entry-1
clack content shared hide --env dev <콘텐츠-UUID> ranking entry-1 --yes
clack content shared delete --env dev <콘텐츠-UUID> ranking entry-1 --yes
```

폐기·숨김·삭제 전에는 대화형 확인을 받습니다. 비대화형 실행에는 `--yes`가 필요합니다.

## 플랫폼 서버 키 조회

콘텐츠별 서버 키를 발급받은 뒤 `CLACK_SERVER_KEY` 환경변수에 설정합니다. 키는 명령 인자나 CLI 자격 파일에 저장하지 않습니다. `--env dev`와 `--env prod`로 대상 API를 지정할 수 있으며 서버 키는 발급받은 환경에서만 사용합니다.

```sh
clack platform usage --from 2026-09-01T00:00:00.000Z --to 2026-09-02T00:00:00.000Z --env dev
clack platform data get scores slot --env dev
clack platform data list scores --limit 20 --env dev
clack platform data leaderboard scores --limit 10 --env dev
```

`usage`는 서버 키 인증을, 데이터 조회는 `data:read` 스코프를 사용합니다. 시청자 범위 조회에는 `--viewer-id v_…`를 지정합니다. 조회 경로와 타입은 공개 OpenAPI에서 생성한 `@clack/types/platform` 계약을 사용합니다. 서버 키(`csk_`)와 `platform:read|write` PAT는 서로 다른 인증 평면이며 섞어 쓸 수 없습니다. PAT용 개인 도구는 위 "플랫폼 전용 PAT 도구" 절을 참고하세요.

단일 문서 쓰기·수정·삭제는 `data:write` 스코프가 필요합니다. PUT/PATCH 본문은 64 KiB 이하의 JSON 객체 파일로 지정합니다. PUT은 `--if-absent` 또는 현재 개정 번호 `--if-rev` 중 하나, PATCH는 `--if-rev`가 필수입니다. 삭제 API에는 개정 조건이 없으므로 대상 확인을 요청합니다. `--dry-run`은 파일과 조건을 검사하고 메서드·경로·본문 크기·SHA-256만 표시하며, 비대화형 실제 변경에는 `--yes`가 필요합니다.

```sh
clack platform data put scores slot --file ./score.json --if-absent --env dev
clack platform data patch scores slot --file ./score-patch.json --if-rev 1 --env dev
clack platform data delete scores slot --env dev
```

`clack mcp config --platform --env dev`는 서버 키 조회와 PAT 개인 도구를 함께 쓸 수 있는 로컬 stdio MCP 설정을 출력합니다. 에이전트 실행 환경에 서버 키 도구용 `CLACK_SERVER_KEY`, 스킬·제작·콘텐츠 공개·공유 문서 도구용 `CLACK_TOKEN`(`platform:read`/`platform:write`, 필요 시 `skill:*`, 제작은 `creator-content:write`, 콘텐츠 공개는 `creator-content:publish`)을 각각 필요한 만큼만 설정합니다. 둘 다 로컬 프로세스 환경변수로만 전달되며 CLI 자격 파일에서 자동으로 읽지 않습니다. Claude 설정 조각은 기본 출력, Codex 설정 조각은 `--codex`로 받습니다. 설정에는 키·토큰 원문이 들어가지 않습니다.

```sh
clack mcp config --platform --env dev
clack mcp config --platform --codex --env dev
```

서버 키(`CLACK_SERVER_KEY`) 도구는 `platform_usage_get`, `platform_server_data_get/list/leaderboard/put/patch/delete`입니다. PAT(`CLACK_TOKEN`) 도구는 `platform_authoring`, `platform_skill_list/get/push/status/submit/release`, `platform_content_publish`, `platform_shared_collections_list`, `platform_shared_documents_list`, `platform_shared_document_get/hide/delete`입니다. `platform_skill_push`는 `dir`(생략 시 현재 디렉터리)의 로컬 스킬 패키지를 검증·업로드합니다. 파괴적 도구(단일 문서 변경, 스킬 심사 제출·공개, 콘텐츠 공개, 공유 문서 숨김·삭제)는 먼저 미리보기와 `confirmation_required`를 반환하고, 입력에 `confirm: true`를 명시해야 실제 요청을 보냅니다. `mcp serve-platform`은 MCP 클라이언트가 실행하는 명령으로, 표준 출력은 JSON-RPC 메시지 전용입니다. 서버 키·PAT의 인증·스코프·테넌트 검사는 모두 API에서 수행합니다.

## 세계관·공개 홈 꾸미기

`page` 명령은 일반 콘텐츠와 별도로 `custom-page:read`, `custom-page:write`, `custom-page:publish` 권한을 사용한다. 페이지 소유자만 편집할 수 있으며 개인 홈의 대상 이용자는 서버가 본인으로 정한다.

| 명령 | 필요한 PAT 권한 |
|---|---|
| `list`, `status`, `preview` | `custom-page:read` |
| `create`, `upload`, `complete`, `presentation` | `custom-page:write` |
| `submit` | `custom-page:write`와 `custom-page:publish` 모두 |
| `apply`, `restore`, `disable` | `custom-page:publish` |

기능 제공 여부는 대상 환경의 센터와 API 설정에 따른다. 페이지 실행·앱 확인 완료는 같은 계정의 앱에서만 수행하며 CLI가 대신하지 않는다. `clack login --scopes custom-page` 약식은 읽기·쓰기만 요청하므로 제출·적용에는 `custom-page:publish`를 추가해야 한다.

```sh
clack page create --target profile --policy-version 2026-09-22
clack page create --target space --space-id WORLD_ID --policy-version 2026-09-22
clack page list
clack page upload PAGE_ID page.html --header translucent_scroll_hide --color dark
clack page preview PAGE_ID VERSION_ID
# 앱에서 같은 계정으로 열고 확인 완료 후 제출
clack page submit PAGE_ID VERSION_ID
clack page status PAGE_ID
# 승인된 버전과 현재 revision을 확인한 뒤 적용
clack page apply PAGE_ID VERSION_ID --revision 0
clack page restore PAGE_ID PREVIOUS_VERSION_ID --revision 1
clack page disable PAGE_ID --revision 2
```

헤더는 `fixed`, `scroll_hide`, `translucent_scroll_hide`, `floating_close`(전체 화면, 화면 끝까지), `floating_close_safe_area`(전체 화면, 안전 영역 안쪽) 중 선택한다. 파일과 헤더를 한 버전으로 저장하므로 헤더만 바뀌어도 앱 확인·심사가 필요하다. 승인만으로 자동 적용되지 않으며 복원도 최신 수정 번호가 필요하다. 충돌 시 `status`를 다시 읽고 의도한 버전을 확인한다. 기본 화면 전환은 파일을 삭제하지 않는다. 업로드 완료 요청만 실패하면 오류에 표시된 `clack page complete PAGE_ID UPLOAD_ID`로 재시도할 수 있다.

페이지 파일은 유지하고 헤더만 바꾸려면 `clack page presentation PAGE_ID VERSION_ID --header scroll_hide --color light`를 사용합니다. 새 비공개 버전이 만들어지며 응답의 새 버전 ID로 앱 확인과 심사를 다시 진행합니다. 기존 적용본은 유지됩니다.

```sh
clack page presentation PAGE_ID SOURCE_VERSION_ID --header scroll_hide --color light
# 응답 data.id의 새 UUID로 이후 절차를 진행합니다.
clack page preview PAGE_ID NEW_VERSION_ID
# 새 버전을 앱에서 확인 완료한 뒤
clack page submit PAGE_ID NEW_VERSION_ID
clack page status PAGE_ID
```

`presentation`은 재호출하면 다른 버전을 만들므로 응답이 유실되면 `status`의 버전 이력을 먼저 확인한다. 같은 업로드를 확정하는 `complete`의 멱등 재시도와 구분한다. 파일은 재사용해도 새 버전은 일일 업로드·논리 저장 한도에 포함된다. 외부 MCP에서도 `revise_custom_page_presentation`으로 같은 작업을 수행한다. 헤더 값과 화면 표시·안전 영역 규칙은 스킬 저장소의 [페이지 헤더·화면 표시 규칙](https://github.com/clack-project/skills/blob/main/clack-page/references/presentation.md)을 참고한다.

### 이미지 화보·캐릭터 가져오기 제작

`clack authoring --input request.json`은 센터와 같은 공개 제작 API를 사용한다. 로컬 MCP는 같은 입력을 `platform_authoring` 도구로 받는다. 개인 액세스 토큰의 `creator-content:write` 권한이 필요하다.

- 세션 시작: `{"action":"create","skill_slug":"clack-character-image","skill_version":"1.0.0"}`
- 조회: `{"action":"get","session_id":"UUID"}`. `save`는 `revision`·`values`, `package`는 `revision`을 함께 보낸다.
- 업로드: `{"action":"upload","session_id":"UUID","field":"plates","item_index":0,"file":"./portrait.png"}`. 응답 자산 ID를 `plates[0].asset_id`로 저장한다.
- 견적: `{"action":"quote","session_id":"UUID"}`. 생성은 `action:"image"` 또는 `"image-batch"`, `form_revision`·`asset_slot`·`approved_price_cash`·`idempotency_key`와 `item_index` 또는 `item_indexes`를 보낸다. 같은 요청의 재시도에는 같은 키를 사용한다.
- 가져오기: `{"action":"import","session_id":"UUID","field":"portrait_source","content_id":"UUID","revision":0}`. 본인 콘텐츠에서 매니페스트가 내보내도록 선언한 값만 복사한다.
- AI 채우기는 `fill-quote` → `fill` → `fill-status`, 자산 목록은 `assets`, 이미지 작업 조회는 `tool`, 폼 검증은 `validate`를 사용한다.

`image_list` 값은 `[{"asset_id":"UUID","scene":"장면","pose":"구도","mood":"분위기","aspect":"1:1"}]`이며 한 번에 최대 8장, 콘텐츠당 최대 24장을 사용한다. 스킬의 `max_calls`와 플랫폼 설정 중 작은 한도를 적용한다. 참조 이미지 생성은 공급자 검증 전 비활성이며 현재 외모·화풍·팔레트 텍스트로 동일성을 안내한다.

크리에이터 센터·가이드는 `/ko`·`/en` 주소를 사용하며 로그인 상태에서는 앱 언어 설정을 따릅니다. 콘텐츠는 SDK 1.2.0의 `clack.locale` 또는 `window.__clack_env?.locale`에서 앱 언어(`language`)·기기 지역(`region`)·BCP 47 태그(`tag`)를 동기적으로 읽습니다. 번역은 `language`로 고르고 숫자·날짜는 `tag`를 `Intl`에 전달합니다. 기존 `me().locale`은 `ko|en`이고 `me().locale_tag`가 전체 태그입니다.

새 다국어 계약은 개발 센터와 최신 staging 테스터 앱에서 제공하며, 운영에서는 센터 초기 출시와 함께 별도로 활성화합니다. 상세 계약과 예제는 개발 센터의 가이드 P11(`/ko/guide/reference/platform/multilingual-content`)을 확인하세요. 앱 언어 환경값이 없는 구버전 앱에서는 `clack.locale.source`가 `browser`이며 브라우저 언어로 대체됩니다.
