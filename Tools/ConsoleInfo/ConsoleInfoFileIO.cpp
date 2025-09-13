#include <Windows.h>
#include <Psapi.h>
#include <stdio.h>
#include <conio.h>
#include <string.h>

#pragma comment(lib, "psapi.lib")

// 辅助函数：设置句柄继承性
void SetHandleInheritance(HANDLE hHandle, bool inherit) {
    SetHandleInformation(hHandle, HANDLE_FLAG_INHERIT, inherit ? HANDLE_FLAG_INHERIT : 0);
}

int main(int argc, char* argv[]) {
    if (argc != 4) {
        printf("用法：ConsoleInfoFileIO.exe <command> <inputFile> <outputFile>\n");
        return -1;
    }

    CHAR Command[MAX_PATH];
    strcpy_s(Command, argv[1]);
    SetConsoleTitleA(Command);
    
    // 打开输入文件
    HANDLE hInput = CreateFileA(
        argv[2],
        GENERIC_READ,
        FILE_SHARE_READ,
        NULL,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        NULL
    );

    if (hInput == INVALID_HANDLE_VALUE) {
        printf("打开输入文件失败: %s，错误码: %d\n", argv[2], GetLastError());
        return -1;
    }

    // 打开输出文件
    HANDLE hOutput = CreateFileA(
        argv[3],
        GENERIC_WRITE,
        0,
        NULL,
        CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        NULL
    );

    if (hOutput == INVALID_HANDLE_VALUE) {
        printf("打开输出文件失败: %s，错误码: %d\n", argv[3], GetLastError());
        CloseHandle(hInput);
        return -1;
    }

    // 配置句柄继承性
    SetHandleInheritance(hInput, true);
    SetHandleInheritance(hOutput, true);
    
    // 明确使用ANSI版本的结构体
    STARTUPINFOA StartupInfo;  // 这里使用STARTUPINFOA而非STARTUPINFO
    PROCESS_INFORMATION ProcessInfo;
    PROCESS_MEMORY_COUNTERS_EX pmc;
    memset(&ProcessInfo, 0, sizeof(ProcessInfo));
    memset(&StartupInfo, 0, sizeof(StartupInfo));
    StartupInfo.cb = sizeof(STARTUPINFOA);  // 明确指定ANSI版本大小
    StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    StartupInfo.wShowWindow = SW_HIDE;
    StartupInfo.hStdInput = hInput;
    StartupInfo.hStdOutput = hOutput;
    StartupInfo.hStdError = hOutput;
    
    // 记录开始时间
    LARGE_INTEGER StartingTime, EndingTime, Frequency;
    QueryPerformanceFrequency(&Frequency);
    QueryPerformanceCounter(&StartingTime);

    // 创建进程（使用ANSI版本的CreateProcessA）
    if (!CreateProcessA(
        NULL, 
        Command, 
        NULL, 
        NULL, 
        TRUE, 
        CREATE_NO_WINDOW, 
        NULL, 
        NULL, 
        &StartupInfo,  // 现在类型匹配了
        &ProcessInfo
    )) {
        printf("创建进程失败: %s，错误码: %d\n", Command, GetLastError());
        CloseHandle(hInput);
        CloseHandle(hOutput);
        return -1;
    }

    // 等待进程结束
    WaitForSingleObject(ProcessInfo.hProcess, INFINITE);
    
    // 获取并输出统计信息
    GetProcessMemoryInfo(ProcessInfo.hProcess, (PROCESS_MEMORY_COUNTERS*)&pmc, sizeof(pmc));
    
    FILETIME creationTime, exitTime, kernelTime, userTime;
    GetProcessTimes(ProcessInfo.hProcess, &creationTime, &exitTime, &kernelTime, &userTime);
    
    QueryPerformanceCounter(&EndingTime);
    LONGLONG executionTime = (EndingTime.QuadPart - StartingTime.QuadPart) * 1000000 / Frequency.QuadPart;
    
    DWORD returnValue;
    GetExitCodeProcess(ProcessInfo.hProcess, &returnValue);
    
    ULARGE_INTEGER kernelTimeUL, userTimeUL;
    kernelTimeUL.LowPart = kernelTime.dwLowDateTime;
    kernelTimeUL.HighPart = kernelTime.dwHighDateTime;
    userTimeUL.LowPart = userTime.dwLowDateTime;
    userTimeUL.HighPart = userTime.dwHighDateTime;
    
    ULONGLONG totalKernelTime = kernelTimeUL.QuadPart / 10;
    ULONGLONG totalUserTime = userTimeUL.QuadPart / 10;
    
    // 清理资源
    CloseHandle(ProcessInfo.hProcess);
    CloseHandle(ProcessInfo.hThread);
    CloseHandle(hInput);
    CloseHandle(hOutput);
    
    // 输出结果
    printf("\n-----------------------------------------------");
    printf("\n总执行时间：%lld.%03lld ms", executionTime / 1000, executionTime % 1000);
    printf("\n内存使用：%lu KB", (unsigned long)(pmc.PeakWorkingSetSize >> 10));
    printf("\nCPU内核时间：%.3f 秒", totalKernelTime / 1000000.0);
    printf("\nCPU用户时间：%.3f 秒", totalUserTime / 1000000.0);
    printf("\n总CPU时间：%.3f 秒", (totalKernelTime + totalUserTime) / 1000000.0);
    printf("\n程序返回值：%ld (0x%lX)", returnValue, returnValue);
    printf("\n-----------------------------------------------");
    return 0;
}
    