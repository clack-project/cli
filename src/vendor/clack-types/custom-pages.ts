/** 모노레포 clack-types/custom-pages.ts에서 복사한 파일이다. 이 파일을 직접 수정하지 말고
 * `scripts/sync-vendor-types.mjs`로 갱신한다. */
/** HTML 파일과 함께 심사·고정되는 네이티브 표시 계약. */
export interface ContentPresentation {
  schema_version: 1;
  header_mode: 'fixed' | 'scroll_hide' | 'translucent_scroll_hide' | 'floating_close';
  color_scheme: 'light' | 'dark';
}

export interface CustomPageDescriptor {
  id: string;
  target_type: 'profile' | 'space';
  user_id: number | null;
  space_id: string | null;
  content_id: string;
  version_id: string;
  revision: number;
  presentation: ContentPresentation;
  presentation_hash: string;
}

export interface CustomPage {
  id: string;
  target_type: 'profile' | 'space';
  user_id: number | null;
  space_id: string | null;
  owner_user_id: number;
  content_id: string;
  enabled: boolean;
  suspended: boolean;
  published_version_id: string | null;
  revision: number;
}
