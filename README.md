# ecampus-mcp

국민대학교 [eCampus](https://ecampus.kookmin.ac.kr)를 Claude 같은 MCP 클라이언트에서 쓸 수 있게 해 주는 MCP 서버입니다.

"이번 주 할 일 정리해줘", "인공지능 강의자료 전부 받아줘", "클라우드컴퓨팅 강의계획서에서 중간고사 범위 알려줘" 같은 요청을 Claude가 직접 처리할 수 있습니다. 읽기 전용이고, 브라우저 없이 HTTP만으로 동작합니다.

## 할 수 있는 것

| 도구 | 내용 |
|---|---|
| `get_todo` | 마감이 있는 과제·동영상·퀴즈·설문을 마감순으로. 제출/수강 여부, 동영상 진도율과 출석(O/X) 포함 |
| `list_courses` | 수강 중인 강좌. `include_past`로 2014년부터의 과거 강좌까지 |
| `get_course` | 강좌의 주차별 자료·동영상·과제·퀴즈·게시판·링크와 완료 여부 |
| `get_video_progress` | 동영상별 진도율, 누적 최대 학습구간, 누적 열람시간, 출석 |
| `get_assignment` | 과제 본문과 첨부파일, 기한, 내 제출 상태와 제출 파일, 점수와 피드백 |
| `get_grades` | 강좌별 성적 항목, 또는 전체 강좌 성적 요약 |
| `list_boards` · `list_posts` · `read_post` | 사이트/강좌 게시판(공지사항, Q&A 등), 글 목록과 검색, 본문·첨부·댓글 |
| `get_notifications` | 최근 eCampus 알림 |
| `get_syllabus` | 강의계획서를 PDF로 저장하고 텍스트로 반환 (과거 강좌 포함) |
| `download_file` | 강의자료, 과제 첨부, 게시판 첨부, 내 제출 파일 |
| `download_course_files` | 강좌 자료 전체를 주차별 폴더로 (이미 받은 파일은 건너뜀) |
| `download_video` | 강의 동영상 원본(mp4) |

## 설치

Node.js 20 이상이 필요합니다.

```bash
git clone git@github.com:son-daehyeon/ecampus-mcp.git
cd ecampus-mcp
npm install
```

강의계획서를 텍스트로 받으려면 `pdftotext`도 설치하세요. 없으면 PDF만 저장됩니다.

```bash
brew install poppler
```

## 로그인

eCampus 아이디/비밀번호(통합 로그인과 같음)를 한 번만 등록하면 됩니다.

```bash
node src/index.js login
```

입력한 정보로 실제 로그인을 시도해서 성공한 경우에만 `~/.config/ecampus-mcp/credentials.json`(권한 600)에 저장합니다. 비밀번호를 바꿨다면 다시 실행하세요.

환경변수 `ECAMPUS_ID`, `ECAMPUS_PW`가 있으면 저장된 정보보다 우선합니다.

## Claude에 연결

**Claude Code**

```bash
claude mcp add ecampus --scope user -- node /절대경로/ecampus-mcp/src/index.js
```

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ecampus": {
      "command": "node",
      "args": ["/절대경로/ecampus-mcp/src/index.js"]
    }
  }
}
```

## 설정

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `ECAMPUS_ID`, `ECAMPUS_PW` | 저장된 로그인 정보 | 로그인 정보 |
| `ECAMPUS_DOWNLOAD_DIR` | `~/Downloads/ecampus` | 다운로드 폴더 |
| `ECAMPUS_CONFIG_DIR` | `~/.config/ecampus-mcp` | 로그인 정보·세션 저장 폴더 |

## 동작 방식

- **로그인**: 학교 SSO(MagicSSO) 로그인을 HTTP로 재현해 세션을 만들고, 그 세션으로 모바일 앱용 API 토큰을 발급받습니다. 세션과 토큰은 `~/.config/ecampus-mcp/session.json`(권한 600)에 저장되고, 만료되면 자동으로 다시 로그인합니다.
- **데이터**: 강좌·과제·퀴즈·성적·알림은 Moodle 모바일 API로, 진도현황·게시판은 웹 페이지를 읽어서 가져옵니다.
- **강의계획서**: 학교 리포트 서버(ClipReport)에서 PDF로 내보냅니다.
- **동영상**: 플레이어를 실행하지 않고 원본 파일 주소를 찾아 내려받습니다.

## 주의

- 게시판·진도현황·동영상 다운로드는 웹 페이지를 읽기 때문에 eCampus 열람 기록에 남을 수 있습니다(교수자의 학습활동현황에 보임). 동영상 다운로드는 플레이어를 실행하지 않으므로 진도·출석은 기록되지 않습니다.
- 진도나 출석을 조작하는 기능은 없고 넣지 않습니다.
- 강의 영상과 자료는 교수자의 저작물입니다. 개인 학습용으로만 쓰고 공유하지 마세요.
- 학교 공식 도구가 아닙니다. eCampus 구조가 바뀌면 일부 기능이 동작하지 않을 수 있습니다.

## 점검

실제 계정으로 모든 조회 기능을 한 번씩 호출해 결과 형태를 검사합니다.

```bash
npm run check
```
