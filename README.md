# ecampus-mcp

> 국민대 eCampus MCP 서버

국민대학교 [eCampus](https://ecampus.kookmin.ac.kr)를 Claude 같은 MCP 클라이언트에서 쓸 수 있게 해 주는 MCP 서버다. "이번 주 할 일 정리해줘", "강의자료 전부 받아줘", "강의계획서에서 중간고사 범위 알려줘" 같은 요청을 클라이언트가 직접 처리한다. 읽기 전용이고 브라우저 없이 HTTP만으로 동작한다.

## 주요 기능
| 도구 | 내용 |
|---|---|
| `get_todo` | 마감이 있는 과제·동영상·퀴즈·설문을 마감순으로. 제출/수강 여부, 동영상 진도율과 출석 포함 |
| `list_courses` | 수강 중인 강좌. `include_past`로 과거 강좌까지 |
| `get_course` | 강좌의 주차별 자료·동영상·과제·퀴즈·게시판·링크와 완료 여부 |
| `get_video_progress` | 동영상별 진도율, 누적 학습구간·열람시간, 출석 |
| `get_assignment` | 과제 본문·첨부, 기한, 내 제출 상태와 파일, 점수와 피드백 |
| `get_grades` | 강좌별 성적 항목 또는 전체 강좌 성적 요약 |
| `list_boards` · `list_posts` · `read_post` | 사이트·강좌 게시판, 글 목록과 검색, 본문·첨부·댓글 |
| `get_notifications` | 최근 eCampus 알림 |
| `get_syllabus` | 강의계획서를 PDF로 저장하고 텍스트로 반환 |
| `download_file` · `download_course_files` · `download_video` | 강의자료·첨부·제출 파일, 강좌 자료 전체(주차별 폴더, 받은 파일은 건너뜀), 강의 동영상 원본(mp4) |

- 로그인: 학교 SSO(MagicSSO) 로그인을 HTTP로 재현해 세션을 만들고, 그 세션으로 모바일 앱용 API 토큰을 받는다. 세션은 `~/.config/ecampus-mcp/session.json`(권한 600)에 저장하고 만료되면 다시 로그인한다
- 데이터: 강좌·과제·퀴즈·성적·알림은 Moodle 모바일 API로, 진도현황·게시판은 웹 페이지를 파싱해서 가져온다. 강의계획서는 학교 리포트 서버(ClipReport)에서 PDF로 내보낸다
- 동영상은 플레이어를 실행하지 않고 원본 주소를 찾아 내려받으므로 진도·출석이 기록되지 않는다. 진도나 출석을 조작하는 기능은 없다
- 게시판·진도현황·동영상 다운로드는 웹 페이지를 읽기 때문에 eCampus 열람 기록에 남을 수 있다. 학교 공식 도구가 아니며, 강의 영상과 자료는 개인 학습용으로만 쓴다

## 기술 스택
| 영역 | 기술 |
|---|---|
| 언어 | JavaScript (Node.js 20 이상, ES 모듈) |
| 프레임워크 | @modelcontextprotocol/sdk 1, cheerio 1, zod 4 |
| 데이터 | eCampus(Moodle) 모바일 API·웹 페이지, pdftotext(선택) |

## 구조
```
src/index.js     MCP 서버(stdio)와 login 명령
src/ecampus.js   도구 정의와 조회·다운로드 처리
src/client.js    SSO 로그인, 세션·토큰 저장, HTTP 요청
src/check.js     실제 계정으로 모든 조회 기능을 호출해 결과 형태를 점검
```

## 실행
```bash
git clone https://github.com/son-daehyeon/ecampus-mcp.git ~/.local/share/mcp/ecampus-mcp
cd ~/.local/share/mcp/ecampus-mcp
npm install
brew install poppler   # 선택: 강의계획서 텍스트 추출용 pdftotext
node src/index.js login

# Claude Code에 등록
claude mcp add ecampus --scope user -- node ~/.local/share/mcp/ecampus-mcp/src/index.js

# 실제 계정으로 점검
npm run check
```
Claude Desktop은 `claude_desktop_config.json`에 등록한다.
```json
{
  "mcpServers": {
    "ecampus": {
      "command": "node",
      "args": ["/Users/<you>/.local/share/mcp/ecampus-mcp/src/index.js"]
    }
  }
}
```
`login`은 입력한 아이디·비밀번호로 실제 로그인에 성공한 경우에만 `~/.config/ecampus-mcp/credentials.json`(권한 600)에 저장한다. 환경 변수: `ECAMPUS_ID`, `ECAMPUS_PW` (저장된 정보보다 우선), `ECAMPUS_DOWNLOAD_DIR` (기본 `~/Downloads/ecampus`), `ECAMPUS_CONFIG_DIR`

---
2026 · 개인 프로젝트 · 사용 중
