<h1 align=center> Dream cpp compiler </h1>

<p align=center>让你方便快速的在 vscode 中编译运行 C++ 文件</p>

<div align=center>
    <img alt="VS Code" src="https://img.shields.io/badge/VSCode-7d57c2?style=for-the-badge"/>
    <img alt="C++" src="https://img.shields.io/badge/C%2B%2B-7d57c2?style=for-the-badge&logo=c%2B%2B&logoColor=white"/>
</div>

<div align=center>
    <a href="https://marketplace.visualstudio.com/items?itemName=wudream.dream-cpp-compiler"><img alt="下载量" src="https://img.shields.io/visual-studio-marketplace/d/wudream.dream-cpp-compiler?style=for-the-badge&color=064f8c"></a>
    <a href="https://marketplace.visualstudio.com/items?itemName=wudream.dream-cpp-compiler"><img alt="版本" src="https://img.shields.io/visual-studio-marketplace/v/wudream.dream-cpp-compiler?style=for-the-badge&color=be2128"></a>
    <a href="https://marketplace.visualstudio.com/items?itemName=wudream.dream-cpp-compiler"><img alt="安装量" src="https://img.shields.io/visual-studio-marketplace/i/wudream.dream-cpp-compiler?style=for-the-badge&color=249847"></a>
    <a href="https://github.com/wudream813/cpp-compiler"><img alt="star 数" src="https://img.shields.io/github/stars/wudream813/cpp-compiler?style=for-the-badge&color=551A8B"></a>
    <a href="https://marketplace.visualstudio.com/items?itemName=wudream.dream-cpp-compiler"><img alt="评分" src="https://img.shields.io/visual-studio-marketplace/stars/wudream.dream-cpp-compiler?style=for-the-badge&color=9400d3"></a>
</div>

# 功能
- 编译、运行 C++ 程序
- 智能编译（记录 Hash 避免重编译，提升编译效率）
- 侧边栏进行编译
- 右键快捷编译
- 状态栏快捷编译
- 快捷文件读写
- 支持所有操作系统（windows, macOS, linux 及其发行版）
- 能够使用 ConsoleInfo 进行输出（快速得知运行使用内存、运行时间）
- 快速自定义编译选项
- 设置编译器路径
- 增强资源管理器
- 根据文件头部文件注释自动设置编译选项等
- 支持虚拟工作区，如 live share，支持临时文件（无需保存文件也可以编译）
- 能够直接选择编译器路径
- 可以设置运行后额外命令，方便使用 checker

<details open>
<summary>
 与普通 C/C++ 插件对比
</summary><br/>
<table>
<tr>
<th>功能</th>
<th>C/C++</th>
<th>dream-cpp-compiler</th>
</tr>
<tr>
<td>编译且运行 C++ 程序</td>
<td>✅</td>
<td>✅</td>
</tr>
<tr>
<td>设置 C++ 程序编译选项</td>
<td>⚠️需要配置 tasks.json</td>
<td>✅</td>
</tr>
<tr>
<td>仅编译 C++ 程序</td>
<td>❌</td>
<td>✅</td>
</tr>
<tr>
<td>中文路径编译、运行 C++ 程序</td>
<td>❌</td>
<td>✅</td>
</tr>
<tr title="记录 Hash 值，避免无用重编译">
<td>智能编译 C++ 程序</td>
<td>❌</td>
<td>✅</td>
</tr>
<tr>
<td>详细显示运行时间、内存等（即 ConsoleInfo）</td>
<td>❌</td>
<td>✅</td>
</tr>
<tr>
<td>虚拟工作区、临时文件的支持</td>
<td>❌</td>
<td>✅</td>
</tr>
<tr>
<td>设置运行后额外命令，如使用 Special Judge</td>
<td>❌</td>
<td>✅</td>
</tr>
<tr>
<td>进行文件重定向</td>
<td>❌</td>
<td>✅</td>
</tr>
<tr>
<td>进行反文件重定向</td>
<td>❌</td>
<td>✅</td>
</tr>
<tr>
<td>进行对每个文件独立设置编译选项</td>
<td>❌</td>
<td>✅</td>
</tr>
<tr>
<td>自动根据注释设置编译命令等</td>
<td>❌</td>
<td>✅</td>
</tr>
</table>
</details>

<strong>警告: 由于编译器设置的特殊性，因此只在用户设置中生效，工作区的设置不会被拓展使用</strong>

<details>
<summary>
 关于 ConsoleInfo
</summary><br/>
能够得知运行一个程序的内存峰值、总执行时间、CPU内核时间、CPU用户时间、程序返回值
</details>

<details>
<summary>
 关于文件重定向、反文件重定向
</summary><br/>
常用于竞赛。

文件重定向: 能够在程序不进行文件读写时，以文件输入输出

反文件重定向: 能够在程序进行文件读写时，从控制台输入输出

配合使用: 将程序输入和输出的文件换为另一个
</details>

<details>
<summary>
 关于根据注释设置编译命令等
</summary><br/>
可用于工程。

在文件头部（前 50 行）打注释，类型为：`key : val`，将会自动使用描述的设置。

如：
```cpp
// compileoptions : -std=c++14 -O2
// outputpath : program.exe
int main(){
    return 0;
}
```

可以使用侧边栏 "高级设置" 中的 "保存设置" 或 "保存模板设置" 自动保存
</details>
