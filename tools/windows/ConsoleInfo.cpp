#include <Windows.h>
#include <stdio.h>
#include <conio.h>

// 自定义 PROCESS_MEMORY_COUNTERS 结构
typedef struct _PROCESS_MEMORY_COUNTERS {
    DWORD cb;
    DWORD PageFaultCount;
    SIZE_T PeakWorkingSetSize;
    SIZE_T WorkingSetSize;
    SIZE_T QuotaPeakPagedPoolUsage;
    SIZE_T QuotaPagedPoolUsage;
    SIZE_T QuotaPeakNonPagedPoolUsage;
    SIZE_T QuotaNonPagedPoolUsage;
    SIZE_T PagefileUsage;
    SIZE_T PeakPagefileUsage;
} PROCESS_MEMORY_COUNTERS;

// 函数指针类型
typedef BOOL(WINAPI *PFN_GetProcessMemoryInfo)(HANDLE, PROCESS_MEMORY_COUNTERS*, DWORD);

int main(int argc, char* argv[]) {
    if (argc != 2) {
        printf("用法：ConsoleInfo.exe <command>\n");
        return -1;
    }

    STARTUPINFOA StartupInfo;
    PROCESS_INFORMATION ProcessInfo;
    memset(&ProcessInfo, 0, sizeof(ProcessInfo));
    memset(&StartupInfo, 0, sizeof(StartupInfo));
    StartupInfo.cb = sizeof(StartupInfo);

    LARGE_INTEGER StartingTime, EndingTime, Frequency;
    QueryPerformanceFrequency(&Frequency);
    QueryPerformanceCounter(&StartingTime);

    char cmdLine[MAX_PATH * 2];
    snprintf(cmdLine, sizeof(cmdLine), "\"%s\"", argv[1]);

    if (!CreateProcessA(NULL, cmdLine, NULL, NULL, FALSE, 0, NULL, NULL, &StartupInfo, &ProcessInfo)) {
        printf("\n无法创建进程：%s", cmdLine);
        return -1;
    }

    // 等待进程结束
    WaitForSingleObject(ProcessInfo.hProcess, INFINITE);

    // 动态加载 GetProcessMemoryInfo
    PROCESS_MEMORY_COUNTERS pmc = {0};
    HMODULE hPsapi = LoadLibraryA("Psapi.dll");
    if (hPsapi) {
        PFN_GetProcessMemoryInfo pGetProcessMemoryInfo =
            (PFN_GetProcessMemoryInfo)GetProcAddress(hPsapi, "GetProcessMemoryInfo");
        if (pGetProcessMemoryInfo) {
            pmc.cb = sizeof(pmc);
            pGetProcessMemoryInfo(ProcessInfo.hProcess, &pmc, sizeof(pmc));
        }
        FreeLibrary(hPsapi);
    }

    // 获取CPU时间
    FILETIME creationTime, exitTime, kernelTime, userTime;
    GetProcessTimes(ProcessInfo.hProcess, &creationTime, &exitTime, &kernelTime, &userTime);

    // 计算总运行时间
    QueryPerformanceCounter(&EndingTime);
    LONGLONG executionTime = (EndingTime.QuadPart - StartingTime.QuadPart) * 1000000 / Frequency.QuadPart;

    // 获取程序退出代码
    DWORD returnValue;
    GetExitCodeProcess(ProcessInfo.hProcess, &returnValue);

    // 将FILETIME转换为微秒
    ULARGE_INTEGER kernelTimeUL, userTimeUL;
    kernelTimeUL.LowPart = kernelTime.dwLowDateTime;
    kernelTimeUL.HighPart = kernelTime.dwHighDateTime;
    userTimeUL.LowPart = userTime.dwLowDateTime;
    userTimeUL.HighPart = userTime.dwHighDateTime;

    ULONGLONG totalKernelTime = kernelTimeUL.QuadPart / 10;
    ULONGLONG totalUserTime = userTimeUL.QuadPart / 10;

    // 关闭句柄
    CloseHandle(ProcessInfo.hProcess);
    CloseHandle(ProcessInfo.hThread);

    // 输出结果
    printf("\n-----------------------------------------------");
    printf("\n总执行时间：%lld.%03lld ms", executionTime / 1000, executionTime % 1000);
    printf("\n内存峰值：%llu KB", pmc.PeakWorkingSetSize >> 10);
    printf("\nCPU内核时间：%.3f 秒", totalKernelTime / 1000000.0);
    printf("\nCPU用户时间：%.3f 秒", totalUserTime / 1000000.0);
    printf("\n总CPU时间：%.3f 秒", (totalKernelTime + totalUserTime) / 1000000.0);
    printf("\n程序返回值：%ld (0x%lX)", returnValue, returnValue);
    printf("\n-----------------------------------------------");

    return 0;
}
