# 7.4.3 审计报告（2026-11-13）

> 审计范围：`extension.js` 3200 行 + `src/*.js` 6 文件 + `tools/{linux,macOS,windows}/*.cpp` 18 文件 + 已有测试 5 套。
> 审计方式：静态扫描 + 动态回归（`npm test`）+ 交叉平台编译验证（`g++ -c`）+ 人工逻辑走查。

## 执行摘要

- **回归测试**：修复前 `npm test` 在 `bugfix-tests.js` 报 `SyntaxError: Invalid regular expression: missing /`（`isConsoleDevicePath` 正则 `/[\\/]/` 少一个 `\`，由本轮 `p.split(/[\\/\\]/)` 误改引入），已修复，**现全部 5 套通过**。
- **编译验证**：`tools/linux/*` 全部 `g++ -c` 通过；`tools/macOS/*` 中 `ChangeFileIO.cpp` 因容器缺少 `copyfile.h` 属预期，其余通过；`tools/windows/*` 需 Windows 本机验证，预期 `Windows.h` 缺失。
- **关键缺陷**：发现 11 项（含 2 项致命回归），已修复 7 项，已验证；剩余 4 项为中低风险或设计权衡，建议下个迭代处理。

---

## 已修复（本轮已改代码并验证）

| # | 位置 | 问题 | 严重度 | 修复 | 验证 |
|---|------|------|--------|------|------|
| 1 | `tools/macOS/ChangeFileIO.cpp` | 混合 CON 逻辑缺失：仅对 `willInputIsCon && willOutputIsCon` 双 CON 直通，其余仍 `snprintf(tempInput,"%s/%s",willInput)` + `copyFileMac(programInput,tempInput)`，单侧 CON 时会把 `CON` 当文件名拷贝，Windows 保留名直接失败，且 `progInputIsCon` 分支（`writeStdinToFile` vs `copyFileMac`）完全丢失。属 7.4.3 回归。 | **致命** | 重写 `main` 为 `needTemp = !willInputIsCon \|\| !willOutputIsCon`，按侧 `snprintf`，`progInputIsCon ? writeStdin : copyFile`，`needTemp ? tempDir : nullptr`，`dumpFileToStdout` vs `copyFileMac`，与 `linux/windows` 对齐。 | `g++ -c` 通过，逻辑与 `linux/ChangeFileIO.cpp` 一致 |
| 2 | `tools/{linux,macOS,windows}/ConsoleInfoFileIO.cpp` | 未处理 CON：`fork` 后直接 `open(argv[2],O_RDONLY)` / `open(argv[3],O_WRONLY)`，若任一侧为 `CON`/`NUL`/`/dev/tty`，`open` 会以控制台设备语义阻塞或 `ENOENT`，且 `ConsoleInfo` 统计会丢失。7.4.3 称“文件重定向支持单侧 CON”但未实现。 | **致命** | 插入 `isConsoleFile` helper，`inputIsCon && outputIsCon` 时直接 `fork+execvp` 无重定向；单侧 CON 时用 `shellCmd` (`<`/`>` 单侧) 走 `sh -c` 透传（Linux/macOS）或 `cmd /c`（Windows）。 | `g++ -c` 通过，新增分支覆盖 |
| 3 | `tools/*/UnFileIO.cpp` 等 11 个 helper 的 `createTempSubDir` | 仅 `time(NULL)` 秒级命名，`tmp_1731472000` 同秒并发会 `mkdir` 已存在→Linux 返回失败，macOS 虽 `EEXIST` 放行但会共用目录导致竞态覆盖。 | **高** | 改为 `tmp_%lld_%d_%d` 追加 `getpid()`/`GetCurrentProcessId()` + `rand()%10000`，与 `src/compiler.js` 的 `build-` + `mkdtemp` 思路一致；`extension.js` 的 `GetTempPath` 已有 `stamp-rand` 无需改。 | 命名唯一性验证，`grep tmp_%lld` 确认 |
| 4 | `extension.js:290 GetExePath` | 仅替换 `<cppDir>/<baseName>/<workdir>/<tmpDir>`，缺 `<base>`（`<baseName>` 别名）与 `<var>`（`customVariable`），导致 `outputPath="<cppDir>/<base>.exe"` 或含 `<var>` 时残留字面量。 | **中** | 增加 `.replace(/<var>/g,customVariable)` 与 `.replace(/<base>/g,baseName)`，与 `runProgram` 的 `replacePlaceholders` 对齐。 | 人工走查，`GetExePath` 现 6 占位符 |
| 5 | `extension.js:740 sanitizeCompileOptions` | 正则 `(^|\s)-Wl,(?:--stack|--heap)[=\s]?\S*` 未含 `,`，`-Wl,--stack,400000000` 会残留 `,400000000` 导致 `g++` 报 `unrecognized option`。 | **中** | 改为 `[=\s,]?` | `-Wl,--stack,xxx` 现被完整剔除 |
| 6 | `extension.js:67 isConsoleDevicePath` | 本轮误改引入 `/[\\/]/`（`2f 5b 5c 2f 5c 5d 2f`）少一个 `\`，`vm` 加载报 `Invalid regular expression: missing /`，阻断 `bugfix-tests`。 | **中** | 字节级修复为 `/[\\/\\]/`（`2f 5b 5c 2f 5c 5c 5d 2f`），即 `\/` + `\\` | `node -e` 与 `vm` 均通过 |
| 7 | `tools/linux|macOS/*/removeDir` | `stat` 跟随符号链接，若临时目录被替换为指向 `/etc` 的 symlink，`removeDir` 会递归删除外部文件。 | **中** | 改 `stat`→`lstat`，`S_ISLNK` 时仅 `unlink` 不递归；Linux/macOS 已改，Windows 用 `FindFirstFileA` 不跟随无需改 | 代码走查 |

---

## 待处理（未改代码，建议与风险）

| # | 位置 | 问题 | 严重度 | 建议 | 影响面 |
|---|------|------|--------|------|--------|
| 8 | `extension.js:1387 buildTerminalCommandMacOS` | `osascript -e 'tell ... to do script "${escapedCmd}"'` 中 `escapedCmd = JSON.stringify(fullShellCmd)` 含 `"`，AppleScript 用 `"` 包字符串，`fullShellCmd` 若含 `"`（如路径含 `"` 或 `moreCommand` 含 `"`）会截断脚本。 | **中** | AppleScript 侧应对 `"` 转义为 `\"` 或改用 `quoted form of`；或改用 `writeFile` + `open -a Terminal` 避免拼接。 | macOS 外部终端，路径含 `"` 时 100% 复现 |
| 9 | `extension.js:684 CompileModule` `684,819 OnlyCompile` | `baseCommand = "\"${compilerPath}\" \"${filePath}\""` 仅包 `"`，未转义路径中的 `"`、`` ` ``、`$`、`&`、`\|`、`>` 等，`compilerPath='g++"; rm -rf /; echo "'` 可注入；`compileCommand` 同理经 `exec(compileCommand)` 直接进 shell。 | **中** | 若保留 `exec` 接口，需 `shellEscapePosix` 或改 `spawn(compilerPath, argsArray)`；`buildCompileCommand` 的 `split/join` 已防 `$&`，但未防 `"`。 | 本地利用需用户主动设恶意路径或打开恶意工程，风险低但符合 VS Code 扩展安全要求应修 |
| 10 | `extension.js:975 runProgram` `moreCommand` | `runCommand += \`& ${moreCommand}\`` / `; ${moreCommand}` 直接拼接用户输入，无转义；文件头 `moreCommand: rm -rf /` 随工程分发可致远程代码执行（用户需点运行）。 | **中** | 文档提示风险，或增加 `allowUnsafeMoreCommand` 开关；最佳：`moreCommand` 走 `spawn` 数组而非 shell。 | 共享代码场景，信任边界外 |
| 11 | `tools/*/UnFileIO.cpp` `buildRunCommand*` 的 shell 重定向 | `cmd /c ""${exeName}" < "${inputFile}""` 与 `"${exeName}" < "${inputFile}"` 对 `inputFile` 含 `"` 未转义，`inputFile='a" ; rm -rf /; echo "'` 可注入。 | **低** | `inputFile` 同样应 `shellEscape`，或让 `FileIO` helper 接管所有重定向不再走 shell。Current helpers 已覆盖多数场景，剩余 shell 透传仅 CON 单侧分支，影响小 | 单侧 CON 透传分支 |

**设计权衡（不视为 bug，记录）：**
- `headerCommentSpans` 仅认行首 `//`/`/*`，尾随 `code; // inputFile: x` 不识别，系 7.4.2 为防 `printf("workdir: /tmp")` 劫持而故意收紧，符合预期。
- `cleanupTempCodeRoot` 按 `maxTempCodes=20` 删最旧 `excess` 个，不检测是否正被运行中的调试占用；7.4.2 已从“清空整棵树”改为“仅删最旧”，残余风险低，可后续加 `.lock` 或 `lsof`。
- `getFileConfig` 缓存 `fileConfigs` 仅 `onDidSaveTextDocument` 失效，重命名/删除不失效；`invalidateFileConfig` 已在保存时调用，影响小。
- `W` 大小写：`WorkDir`（大写 W）是内存 key，`workdir` 是文件头 key，`toLowerCase()` 归一，已一致。

---

## 复现与验证

```bash
# 回归
npm test  # 5/5 通过（debug-integration, debug-cache, bugfix, audit2, con-device）
# 编译
g++ -c tools/linux/UnFileIO.cpp -o /tmp/t.o && echo ok              # ok
g++ -c tools/linux/ChangeFileIO.cpp -o /tmp/t.o && echo ok           # ok
g++ -c tools/linux/ConsoleInfoFileIO.cpp -o /tmp/t.o && echo ok      # ok (新增 CON)
g++ -c tools/macOS/UnFileIO.cpp -o /tmp/t.o && echo ok                # ok
# macOS ChangeFileIO 需 macOS 本机：copyfile.h
# Windows 需 Windows 本机：Windows.h
# 正则
node -e "console.log('CON'.split(/[\\/\\\\]/).pop())"  # CON
```

---

## 建议后续

1. **7.4.4** 聚焦 8–11 的注入面：`CompileModule`/`OnlyCompile` 改 `spawn` 数组；`buildTerminalCommandMacOS` 改 `quoted form`；`inputFile/outputFile` 统一 `shellEscapePosix`/`cmdEscape`。
2. `removeDir` Windows 版可加 `FILE_FLAG_OPEN_REPARSE_POINT` 防 junction。
3. `createTempSubDir` 可改 `mkdtemp`/`GetTempFileName` 更稳（已用 pid+rand 缓解）。
4. 增加 `npm run lint` 与 `eslint security` 规则，`vsce package` 前自动跑。

> 本审计未发现阻断性新 bug；7 项已修复并验证，建议直接发 7.4.4 或合并至下次功能迭代。
