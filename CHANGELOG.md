# 변경 이력

## 다음 릴리스

- `content info-version`의 HTTP 200 재사용 안내를 같은 정보의 미게시 버전(초안·심사 중·승인 미게시)으로 바로잡았다. 응답의 `created`를 그대로 출력하는 동작은 유지한다.

## 0.3.0

- `content update <id>`를 추가했다. 콘텐츠 제목·설명·종류·썸네일·메타데이터(대표 언어·언어별 제목/설명)·태그를 서버 PATCH와 같은 필드·길이 규칙으로 수정한다(`creator-content:write`). 서버가 거부할 입력은 요청 전에 막는다.
- `content info-version <id> <version-id>`를 추가했다. 승인·반려된 버전의 번들을 재사용해 바뀐 정보만 담은 새 초안 버전을 만든다(`creator-content:write`). 게이트가 꺼진 환경의 `CONTENT_INFO_VERSION_DISABLED`, 바뀐 정보가 없는 `CONTENT_INFO_UNCHANGED`, 언어별 메타데이터 게이트 `CONTENT_METADATA_EXTRAS_DISABLED`는 다음에 할 일을 안내한다.
- 공유 제작 계약 사본을 최신으로 맞췄다. 스킬 매니페스트 `display`의 다국어 키(`description`·`tags_i18n`·`release_notes`)를 허용한다(`tags_i18n`은 `tags`가 있어야 한다). 공식 캐릭터챗 2.2.1 폼의 다국어 안내·자리표시 키(`x-clack-help-i18n`, `x-clack-placeholder-i18n`)를 `skill validate`·`skill pack`·`skill push`가 통과시키고, 인트로 자동 구성 라벨 길이를 서버와 같이 언어별 최댓값으로 계산한다.

## 0.2.0

- 스킬 에디터(`authoring.editor`) 스킬을 로컬에서 검사한다. `skill validate`·`skill pack`·`skill push`가 에디터 번들 구조·한도(파일 50개·파일 512 KiB·전체 2 MiB·코드 512 KiB)·번들 해시, 데이터 스키마(`output-data.v1`)·예시 문서를 서버와 같은 공유 계약으로 판정하고, 지연 로드 의심(`loading="lazy"`·동적 `import()`·CSS `url()`)은 경고로 알린다. 에디터 코드 정적 검사(`editor-static-v1`)와 심사는 서버 판정이 최종이다.
- `skill pack`이 ZIP을 만들면서 `authoring.editor.sha256`을 번들 해시로 채운다. `--write-manifest`로 채운 값을 `clack.skill.json`에도 기록한다. `skill push`도 같은 값을 채워 올린다.
- `skill editor dev`를 추가했다. 스킬 에디터 SDK의 모의 호스트로 로컬에서 에디터를 열어 본다(로그인 불필요). SDK는 아직 npm에 공개되지 않아 `--sdk-dir`·`CLACK_SKILL_EDITOR_SDK_DIR`·`CLACK_MONOREPO_DIR`로 빌드한 SDK 위치를 지정한다(`--help`와 README에 안내).
- `skill list`·`skill get`이 에디터 스킬에 `availability: "센터 전용"`을 표시한다. 에디터 스킬은 v1에서 크리에이터 센터에서만 제작할 수 있다.
- 공유 제작 계약 사본을 최신으로 맞췄다. 스킬 패키지 검사가 콘텐츠 인트로 출력 선언(`output.intro`)을 인식·검사한다.
- 헤더 표시에 `floating_close_safe_area`(전체 화면, 안전 영역 안쪽)를 추가했다. `content upload`·`page upload`·`page presentation`의 `--header`와 스킬 매니페스트 검사에서 쓸 수 있다.

## 0.1.1

- 승인 대기 중 프로세스가 끝나도 발급한 로그인 요청을 저장해 두어(0600) `clack login --resume`으로 이어받을 수 있다. `clack login --no-wait`로 코드만 발급하고 바로 반환하는 모드도 추가했다. 만료·거부·이미 교부된 요청은 명확한 오류 코드로 처리하고 자동으로 새 요청을 만들지 않는다.
- 로그인 성공 출력의 만료 시각을 실행 환경의 로캘·타임존과 무관한 고정 형식(`YYYY-MM-DD HH:MM KST`)으로 통일했다. 오전/오후 표기가 실행 환경에 따라 달라지던 문제를 없앴다.
- `skill deprecate`·`skill release`에서 토큰이 없을 때 필요한 권한을 `skill:write`로 잘못 안내하던 문제를 고쳤다. 두 명령 모두 `skill:publish`가 필요하다. README의 스킬 권한 안내도 같이 고쳤다.
- `content`·`page`·`skill`의 하위 명령 도움말(`--help`)에 필요한 권한을 표시한다. 심사 제출(`content submit`·`page submit`·`skill submit`)에는 쓰기와 게시(publish) 권한이 둘 다 필요하다는 점을 명시했다. README에 콘텐츠·스킬 명령별 권한 표를 추가했고, `login --scopes` 도움말에 묶음 이름은 읽기·쓰기만 요청하므로 `*:publish`를 따로 적어야 한다고 안내한다.
- 로컬 플랫폼 MCP 도구 설명과 `mcp config --platform` 안내에 빠져 있던 권한(`skill:read`, 제작 도구의 `creator-content:write`)을 추가했다.
- `clack skills` 안내의 최소 CLI 버전을 0.1.1로 올렸다. 출력에 공개 에이전트 스킬 10종 목록과 스킬별 요구 CLI 버전(`skills`), 여러 스킬 선택 설치 예시를 추가했다. README의 스킬 안내도 10종으로 고쳤다.

## 0.1.0

- 클랙 CLI 첫 공개. 프로필·상품·게시글·크리에이터 채널·업로드·설정·콘텐츠(HTML)·스킬 패키지·세계관 페이지 명령을 제공한다.
- 개인 액세스 토큰(`pat_`) 기반 로그인, MCP 설정 출력(`clack mcp config`), 에이전트 스킬 안내(`clack skills`)를 제공한다.
- 콘텐츠 서버 키·공유 문서 관리, 플랫폼 서버 키 데이터 도구(`clack platform`)를 제공한다.
