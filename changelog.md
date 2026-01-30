# dream-cpp-compiler v7.1.0
> UI 更新，添加保存设置功能
> 现在编辑会保存模板字符串了
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
