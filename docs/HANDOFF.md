# MySong — 작업 기억 / 인수인계 (Handoff)

> 작성일: **2026-07-03 (금)** · 재개 예정: **다음 주 (2026-07-06 주간)**
> 작성자: Claude (Opus 4.8) · 요청자: racji92@gmail.com

## 한 줄 요약
Tauri 2 심플 사운드 플레이어(로컬 mp3/wav/m4a + YouTube). **기능 전부 구현 완료 + 빌드/실행 검증 완료.** 바로 이어서 작업 가능한 상태.

---

## 현재 상태: ✅ 완료 & 검증됨
- `tsc --noEmit` 통과, `vite build` 통과, `cargo check` 통과
- **전체 Tauri 빌드 성공** → `src-tauri/target/debug/mysong.exe` (약 13.4MB)
- 실행 스모크 테스트 통과(크래시 없음, 로그 클린) + 창 스크린샷 육안 확인(시안과 일치)

## 구현된 요구사항 체크리스트
- [x] 재생 / 일시정지 / 정지
- [x] 플레이바(구간 이동) + 현재/전체 시간
- [x] 볼륨 슬라이더 + 음소거 (골드 채움 트랙)
- [x] 재생방법 3종 순환: `1회` / `1곡 반복` / `여러곡 반복`
- [x] 파일·폴더 **드래그 앤 드롭**, `+폴더` 임포트(하위폴더 스캔)
- [x] `폴더 선택` 드롭다운 필터 + `✕` 해제
- [x] YouTube URL 상단 입력 → `+`/Enter로 하단 리스트 추가
- [x] 리스트 **드래그 정렬**(다중선택 시 동시 이동)
- [x] 다중선택(Ctrl/Shift+클릭) + `Del`/행 `✕`로 **리스트에서만 삭제**
- [x] 웨이브폼(노란 EQ 애니메이션) + 곡명 마퀴
- [x] 프레임리스 창: 상단바 드래그 이동, `▾` 접기, `–` 최소화, `✕` 닫기
- [x] 우측 하단 모서리 크기조절
- [x] 블랙 테마 / 화이트+노란색 텍스트
- [x] 앱 아이콘: 다홍색 라운드 사각형 + 흰 ♪ + M
- [x] 리스트 자동 저장(localStorage) → 재실행 시 복원

---

## 실행 / 빌드
```powershell
npm install              # 최초 1회
npm run tauri dev        # 개발(핫리로드)
npm run tauri build      # 배포 빌드 → src-tauri/target/release/mysong.exe
```
- Node 22 / Rust 1.94 / tauri-cli 2.10.1 환경에서 빌드 확인됨.

## YouTube 재생 전제조건
- 재생하려면 `yt-dlp`가 PATH에 있어야 함. 없으면 로컬 재생·목록추가는 정상, YouTube **재생** 시 안내 메시지 표시.
- 설치: `winget install yt-dlp` 또는 `pip install -U yt-dlp` 또는 `scoop install yt-dlp`

---

## 아키텍처 / 파일 지도
```
index.html            레이아웃(커스텀 타이틀바·컨트롤·웨이브·소스·YT·목록)
src/
  main.ts             전체 배선(이벤트/상태), 창 제어, 파일 드롭, 영속화
  player.ts           AudioController: 단일 <audio> 래퍼(로컬 asset + 원격 스트림)
  playlist.ts         Playlist: 모델 + 드래그정렬·다중선택·삭제·필터
  visualizer.ts       Visualizer: 캔버스 웨이브폼(애니메이션)
  backend.ts          Tauri 커맨드 래퍼 + convertFileSrc
  icons.ts            인라인 SVG 아이콘
  styles.css          블랙 테마(화이트/노란색)
src-tauri/
  src/lib.rs          커맨드: scan_folder / ytdlp_available / youtube_title / resolve_youtube
  tauri.conf.json     창 설정 · CSP · asset 프로토콜(scope **)
  capabilities/default.json  권한(창 이동/리사이즈/닫기/최소화/set-size, dialog)
```

## 핵심 설계 결정 (배경 = 왜)
1. **YouTube = yt-dlp 오디오 추출 방식.** 재생 시 `resolve_youtube`가 `-f bestaudio`로 직행 스트림 URL을 얻어 `<audio>`로 재생. (임베드/외부재생 대신 선택 → 앱 내 통합 재생 위해)
2. **웨이브폼 = 애니메이션(시뮬레이션) 방식.** 원격 스트림은 CORS 때문에 Web Audio AnalyserNode로 분석 시 **소리가 뮤트**되는 문제가 있어, 로컬·유튜브 모두 재생상태·볼륨에 반응하는 시각화로 통일. (뮤트 리스크 회피 우선)
3. **불투명 다크 창 + 라운드 코너.** Windows 투명창 리스크 회피. `body` 배경을 `#08090d`로 깔아 라운드 코너의 흰 삼각형 아티팩트 제거.
4. **재생 종료 로직**: `once`→정지, `one`→현재곡 재생, `all`→다음곡(끝이면 첫곡 순환).

---

## 다음 주 재개 시 후보 작업 (사용자에게 제안했던 옵션)
- [ ] **`yt-dlp` 번들 내장** — 현재는 시스템 설치 의존. 앱에 사이드카로 포함해 무설치 재생 가능하게.
- [ ] **로컬 파일 실오디오 웨이브** — 로컬 파일에 한해 진짜 FFT 반응 웨이브 적용(원격은 애니메이션 유지). asset 프로토콜 CORS(뮤트) 확인 필요.
- [ ] **`1회` 버튼 아이콘 개선** — 현재 아이콘이 시계처럼 보임. 더 명확한 반복/1회 아이콘으로 교체.
- [ ] (선택) 릴리스 빌드 + 설치 파일(NSIS/MSI) 생성 및 배포.
- [ ] (선택) 단축키(스페이스=재생/정지, ←/→=구간이동) 추가.

## 알려진 사소한 사항
- 아이콘에서 M 상단이 ♪ 기둥과 살짝 겹침(브랜딩상 문제 없음).
- 유휴 상태 웨이브폼은 얇은 노란 점선처럼 보임(재생 시 정상 EQ로 상승).

## 참고
- 상위 `E:\Project`가 커밋 없는 git 저장소라 자동 커밋은 하지 않음. 별도 커밋/레포 분리 원하면 요청 시 진행.
