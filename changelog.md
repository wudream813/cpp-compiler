## 7.4.5

- 修复“反文件读写 + 指定目录运行”失效：`runProgram` 在外层 `cd effectiveWorkdir` 后再 `UnFileIO`，但 `UnFileIO`/`ChangeFileIO` 内部又 `chdir(tempDir)`/`CreateProcess(workingDir=tempDir)`，导致 `fopen("data/a.txt")` 等相对路径解析到 `/tmp/...` 而非 `WorkDir`；现 `extension.js` 的 `buildRunCommand*` 透传 `workDir: effectiveWorkdir` 至 helper 第 6/5 参数，`tools/{linux,macOS,windows}/{UnFileIO,ChangeFileIO,ConsoleInfo*}.cpp` 解析可选 `workDir` 并在 `needTemp` 时 `mirrorWorkDir(Win)` 将 `WorkDir` 资源递归镜像到 `tempDir`（`lstat` + `S_ISLNK` 跳链接、`pid+rand` 防并发、`isConsoleFile` CON 直通保留），`WorkDir/data/a.txt` 现可被 `fopen` 正常读取。
- 顺带修复 `tools/windows/UnFileIO.cpp` 预存的 `isConsoleFile(inputFile)` 未定义变量回归，以及 `windows/ConsoleInfoChangeFileIO.cpp` 等遗漏的 `mirrorWorkDirWin` 调用。

## 7.4.4

- 修复剩余 shell 注入面：`CompileModule`/`OnlyCompile` 由 `exec(shell)` 改为 `spawn` 数组（`parseShellTokens` 解析 `compileCommand` 模板，`compilerPath`/`staticOption`/`compileOptions` 均按词法分词），路径含 `"`/`;`/`&`/`|` 等不再截断或注入；`buildRunCommand*` 对 `inputFile`/`outputFile`/`exeName` 统一经 `shellEscapePosix`/`shellEscapeWin` 转义，`"`→`""`（Win）/`'\''`（POSIX）避免 `inputFile='a"; rm -rf /'` 劫持。
- 修复 `buildTerminalCommandMacOS` 的 AppleScript 注入：原 `JSON.stringify(fullShellCmd)` 直接塞进 `do script "${escapedCmd}"`，`"` 会截断脚本；现经 `appleScriptEscape` 转义 `\\`/`"`/`\n`，路径含 `"` 时外部终端可正常打开。
- 修复 `GetExePath` 缺占位符：补 `<base>`（`<baseName>` 别名）与 `<var>` 替换，与 `runProgram` 的 `replacePlaceholders` 对齐，`outputPath="<cppDir>/<base>.exe"` 或含 `<var>` 时不再残留字面量。
- 修复 `sanitizeCompileOptions` 漏逗号：`[=\s]?` → `[=\s,]?`，`-Wl,--stack,400000000` 现被完整剔除，Linux/macOS 不再残留 `,400000000` 导致 `ld` 报错。
- 加固 `tools/*/removeDir` 符号链接：`stat`→`lstat`，`S_ISLNK` 时仅 `unlink` 不递归，防止临时目录被替换为指向外部的 symlink 时误删。
- `moreCommand` 含 `;&|\`$()` 等元字符时输出 `ShowWarn` 提示（仍按用户配置原样执行，兼容刻意 `&&` 链式），并随 `AUDIT_7.4.3.md` 记录 11 项审计结果。
- 同步修复 `macOS/ChangeFileIO.cpp` 混合 CON 回归（仅双 CON 直通，单侧仍 `copyFileMac`）与 `ConsoleInfoFileIO` 三平台 CON 透传缺失（新增 `isConsoleFile` 单侧 `fork/sh` 回退），`createTempSubDir` 加 `pid+rand` 防同秒并发。

## 7.4.3


- 修复“反文件读写”不适用从 CON 读入 / 输出的文件读写的问题：`CON` / `CONIN$` / `NUL` / `/dev/tty` 等控制台设备名此前会被当成普通文件去创建临时文件，在 Windows 上会因保留名直接失败，混合模式（控制台读入而文件输出，或反之）也无法处理。现在 `extension.js` 新增 `isConsoleDevicePath` 检测，`UnFileIO` / `ChangeFileIO`（含 `ConsoleInfo*` 变体）在所有平台（`tools/linux` / `macOS` / `windows`）均支持：输入输出均为 CON 时直接运行；仅一侧为 CON 时只处理另一侧的文件（控制台读入而文件输出，或文件读入而控制台输出），避免把控制台设备当成普通文件 `rm -rf` 或 `CopyFile`。
- 文件重定向（`ConsoleInfoFileIO` / shell `< >`）同样支持单侧 CON：输入或输出为 CON 时跳过该侧的重定向，控制台透传。
- 新增 `tests/con-device-tests.js`（8 项），覆盖 CON 设备名大小写、带路径/带扩展名、`com1`/`lpt1` 等保留名及 POSIX `/dev/tty` 等。

## 7.4.2


- 修复「保存设置」会改写源码的问题：文件头配置只解析注释行（`//`、`/* */` 及块注释续行），`printf("workdir: /tmp")` 这类普通语句不再被当成配置行就地替换；改写块注释配置时也不再吃掉行尾的 `*/`。
- 修复取消「以临时文件进行编译运行」可能删除工程目录的问题：原逻辑在没有临时目录记录时会兜底使用 webview 传来的工作目录并 `rm -rf`；现在只删除位于扩展临时目录（`<tmp>/dream-cpp-compiler/tmpcode`）之下的目录，其余一律跳过。
- 修复 Linux 外部终端在路径含空格时完全无法运行的问题：`buildTerminalCommandLinux` 原本在已带双引号的命令外又套了一层 `bash -c "..."`，外层 shell 会在第一个内层引号处截断；现改用单引号转义生成脚本。
- 修复普通代码行可以劫持文件头配置的问题（与第一条同源）：`printf("outputPath: /tmp/evil.exe")` 不再改动输出路径等设置。
- 修复「以临时文件进行编译运行」勾选框切换文件后不复位的问题：现在按文件下发状态并恢复勾选，避免沿用一个文件的勾选状态。
- 修复 `dream-cpp-compiler.useStaticDefaultValue` 设置从未声明导致静态编译默认值无法配置的问题（package.json 已补上声明）。
- 修复临时目录超限时整棵树被清空的问题：现在按时间戳只删除最旧的若干个，不再连带删除其他窗口正在使用或程序正在运行的目录。
- 修复 `staticOption` 设成空字符串时仍会被回退成 `-static` 的问题，现在可以真正不追加任何静态编译参数。
- 新增 `tests/audit2-tests.js`（11 项回归），`npm test` 会一并执行。

## 7.4.1

- 修复内置终端运行报“终端进程已终止，退出代码 -1073741510”的问题：以前每次运行都会先向终端发送 `^C\x03`，向空闲的 cmd.exe 写入 ETX 会让它以 `STATUS_CONTROL_C_EXIT(-1073741510)` 退出；现在只在终端确实有命令运行时才发送 Ctrl+C（基于 shell integration，旧版 VS Code 自动降级为不发送）。
- 修复“根据注释设置编译命令 / 自定义编译命令”不生效的回归：`OnlyCompile` 中重复声明的 `compileCommand` 覆盖了模板生成的命令，`compileCommand` 设置与文件头注释都被忽略；现在按模板生成，并同时兼容旧版 `{cPath}` 与 `<cPath>` 两种占位符。
- 修复默认编译选项在 Linux / macOS 上必定编译失败的问题：`-Wl,--stack=400000000` 是 Windows 链接器选项，现在按平台给出默认值，并从用户选项里剔除不被支持的 `-Wl,--stack/--heap`。
- 修复侧边栏“编译设置 / 运行控制”区块的默认展开设置永远无效（`|| true` 恒为真）。
- 修复打开不存在的文件时读取配置抛出 `TypeError`。
- 修复 `<baseName>` 只处理 `.cpp`：`.cc/.cxx/.c++/.CPP` 等文件的输出路径不再带上源文件扩展名（此前输出路径会与源文件重名）。
- 修复 `<base>` 占位符没有在运行期替换，导致侧边栏预览与实际执行不一致（更多运行命令、文件读写路径）。
- 修复 macOS 上“在外部终端打开”调用未定义的 `shellEscapePosix` 抛出 ReferenceError。
- 修复 macOS 上 ConsoleInfo / 文件重定向模块编译必定失败的问题：`-static` 不被 clang 支持，现自动回退为动态链接；模块源码目录大小写由 `macos` 更正为 `macOS`（区分大小写的文件系统上原路径不存在）。
- 修复 Linux / macOS 下可执行文件路径含空格时运行命令失效（路径未加引号）。
- 修复“保存设置”会把全局项 `useConsoleInfo` 写进源码头部注释。
- 修复手动修改文件头注释后配置不刷新：保存文件即让配置缓存失效。
- 修复侧边栏监听器在视图重建时重复注册、扩展反激活时输出通道未释放。
- 恢复同一时间只允许一个编译任务的行为。
- 未保存 / 非本地文件直接运行时给出提示，而不是静默失败。
- 新增 `tests/bugfix-tests.js` 回归测试；`npm test` 现在会执行全部测试（原来的 `test/runTest.js` 并不存在）。

## 7.4.0

- 恢复联动调试的智能编译：在 VS Code 会话内复用经过校验的闲置调试构建。
- 源码、预处理依赖、选项或编译器变化时重新编译；正常关闭扩展时自动清理闲置缓存。
- 调试编译支持取消，不改变普通运行构建缓存。

## 7.3.1

- 未安装或未启用 Dream C++ Debugger 时隐藏侧栏 GDB 调试按钮及命令面板入口；扩展状态变化时刷新。
- GDB 调试按钮仅对本地 C++ 文件启用，保留编译器原有功能。

## 7.3.0

- 增加与 Dream C++ Debugger 的可选调试构建接口和侧栏入口。
- 调试构建使用独立产物与 `-g -O0`，不修改普通运行的构建缓存。

# dream-cpp-compiler v7.2.1
> 修复了一处临时文件运行的 bug
# dream-cpp-compiler v7.2.0
> 添加以临时文件编译运行，现在即使不是本地文件，也可以编译运行了
> 添加功能：在指定目录运行
# dream-cpp-compiler v7.1.0
> UI 更新，添加保存设置功能
> 现在编辑会保存模板字符串了
> 支持 macOS!
# dream-cpp-compiler v7.0.1
> 修复了根据注释设置编译命令无作用的 bug
# dream-cpp-compiler v7.0.0
> 修复了 windows 无法运行的 bug
> 添加功能：根据注释设置编译命令
> 添加功能：设置输出可执行文件的路径
> 添加功能：设置编译模板，用于适配其他编译器
# dream-cpp-compiler v6.1.0
> 修复了 linux 无法运行的 bug
# dream-cpp-compiler v6.0.0
> 修复了 linux 系统下，vscode 无管理员权限，无法运行 ConsoleInfo 的 bug
> 现在，ConsoleInfo 将会被即时编译，可执行文件放在临时文件夹的 ".dream-cpp-compiler" 文件夹中
> 现在只存放源码，拓展大小大幅减小了
# dream-cpp-compiler v5.2.2
> 修复了编译器缓存的 bug
# dream-cpp-compiler v5.2.1
> 修改了 readme.md
# dream-cpp-compiler v5.2.0
> 现在支持设置编译器了
# dream-cpp-compiler v5.1.0
> 添加运行终端的完善逻辑
# dream-cpp-compiler v5.0.3
> 修复了 baseName 的一个 bug
# dream-cpp-compiler v5.0.2
> v5.0.0 的 readme.md 尚未更新，此版本更新了
# dream-cpp-compiler v5.0.0
> 添加了高级选项区块，现在，你可以在编译后执行自定义命令，还有一个自定义变量，对于打比赛很有用
> 比如，你可以直接运行后 `./my_check {baseName}.out {baseName}{var}.ans`，可以很方便的测样例
> 修复了一个快捷键冲突
# dream-cpp-compiler v4.1.0
> 编译现在有信息框提示了
> 修改了：不允许同时编译文件
# dream-cpp-compiler v4.0.0
> 修复大量 bug：
> - ConsoleInfoChangeFileIO.exe 无法正常使用
> - 运行与编译不同步
> - 图标不同步
# dream-cpp-compiler v3.5.1
> v3.5.0 Readme.md 头图炸了，此版本已修复
# dream-cpp-compiler v3.5.0
> 现在支持设置文件输入输出路径默认值
> readme.md 添加 To do
> 修复了 v3.4.1 的重大不同步 bug!
# dream-cpp-compiler v3.4.1
> 更改了输出通道的显示方式，同步部分设置名
> **警告！此版本应为修改名称，导致出现设置不同步。因此此版本已被弃用，请使用 v3.5.0**
# dream-cpp-compiler v3.4.0
> 修复了 ConsoleInfo 的 bug
> readme.md 美化了！
# dream-cpp-compiler v3.3.0
> 新增了编译默认选项，修复了 ConsoleInfo 的一些 bug。
> 添加更多关键词，你可以搜：
> - `cpp`
> - `c++`
> - `compiler`
> - `run`
> - `compile`
> - `dream-cpp-compiler`
> - `Wu_Dream 的 C++ 编译器`
> 或 [vscode 拓展市场](https://marketplace.visualstudio.com/items?itemName=wudream.dream-cpp-compiler)来找到我的拓展
# dream-cpp-compiler v3.2.1
> 将编译选项对于每个程序独立
# dream-cpp-compiler v3.2.0
> 正式在 vscode 拓展市场发布！
> 同时，将拓展名改为 `dream-cpp-compiler`（原因为拓展市场已有此 ID）
# cpp-compiler v3.1.0
> 支持查看警告
# cpp-compiler v3.0.1
> 将代码进行了整理
# cpp-compiler v3.0.0
> 全面支持 linux!!!
# cpp-compiler v2.8.1
> 修复勾选框意外拉伸bug
# cpp-compiler v2.8.0
> 删去臃肿的一些 UI，改动了一些图标
# cpp-compiler v2.7.0
> 删除代码片段功能，修复了页面切换更新不同步 bug，UI 稍改，做了一个好看点的图片
# cpp-compiler v2.6.0
> 新增代码片段，增强资源管理器
# cpp-compiler v2.5.0
> UI 更美观了
# cpp-compiler v2.4.1
- 添加 `changelog.md`
> 微改，修复一个动画的奇怪 bug，同时添加了 `changelog.md`（突然想起）
# cpp-compiler v2.4.0
> 大改，现在的折叠框对每个文件独立记录，不用重新一个一个点了，动画也很丝滑。
# cpp-compiler v2.3.1
> 小改，将默认g++编译选项从 `-std=c++17 -Wall -O2` 改为了更大众的 `-std=c++14 -Wall -O2 -Wl,--stack=400000000`。
# cpp-compiler v2.3.0
- **删除输入文件路径、输出文件路径、反文件输入路径、反文件输出路径设置**
> 文件读写现在对于每个文件独立了，动画也进行了调整，更平滑了
# cpp-compiler v2.2.0
> 修复了 v2.1.0 箭头方向有问题的bug，UI美化
# cpp-compiler v2.1.0
> 更加丝滑的 UI
# cpp-compiler v2.0.0
> 从此支持文件读写与反文件读写，侧边栏也同步更新了
# cpp-compiler v1.6.1
> 添加了右键菜单栏快捷编译。
# cpp-compiler v1.6.0
> 修复了很多 bug
# cpp-compiler v<1.6.0
> 属于内测阶段
