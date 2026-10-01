# 기여 안내

이 저장소는 클랙 CLI(`@clack-platform/cli`) 소스를 공개한다. 이슈·제안은 GitHub Issues에 남긴다.

## 개발

```sh
pnpm install --frozen-lockfile
pnpm check    # typecheck → 스키마 동기화 확인(모노레포 없으면 건너뜀) → 테스트 → 빌드
```

- Node.js 20 이상, pnpm이 필요하다.
- 커밋 전 `pnpm check`를 통과해야 한다. 배포 태그를 준비할 때는 `pnpm check:release`로 엄격 검사(스키마 일치·`src/vendor/` 사본 동기화)를 추가로 실행한다.
- `src/vendor/`의 파일은 클랙 내부 저장소에서 복사한 사본이다. 직접 수정하지 말고 해당 파일 상단 안내를 따른다.
- 비밀값·개인정보·내부 시스템 주소를 코드나 테스트 픽스처에 커밋하지 않는다.

## 릴리스

`v0.1.0` 형태의 태그를 push하면 GitHub Actions가 태그와 `package.json` 버전 일치를 확인한 뒤 npm에 공개한다. 버전을 올릴 때는 `package.json`의 `version`을 먼저 갱신하고 커밋한 뒤 태그를 만든다.
