# 변경 이력

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
