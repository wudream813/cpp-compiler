#include<iostream>
#include<limits.h>
#include<cstring>
#include<fstream>
#include <Windows.h>
#include <Psapi.h>

using namespace std;

int main(int argc, char* argv[]) {
    SetConsoleOutputCP(CP_UTF8);
    if (argc != 4) {
        printf("用法：ConsoleInfoUnFileIO.exe <command> <inputFile> <outputFile>\n");
        return -1;
    }
    ofstream out(argv[2]);
    for(string r; getline(cin, r);) {
        out << r << '\n';
    }
    out.close();
    STARTUPINFOA StartupInfo;
    PROCESS_INFORMATION ProcessInfo;
    PROCESS_MEMORY_COUNTERS_EX pmc;
    memset(&ProcessInfo, 0, sizeof(ProcessInfo));
    memset(&StartupInfo, 0, sizeof(StartupInfo));
    StartupInfo.cb = sizeof(StartupInfo);

    LARGE_INTEGER StartingTime, EndingTime, Frequency;
    QueryPerformanceFrequency(&Frequency);
    QueryPerformanceCounter(&StartingTime);

    if (!CreateProcessA(NULL, argv[1], NULL, NULL, FALSE, 0, NULL, NULL, &StartupInfo, &ProcessInfo)) {
        printf("\n无法创建进程：%s", argv[1]);
        return -1;
    }

    // 等待进程结束
    WaitForSingleObject(ProcessInfo.hProcess, INFINITE);

    // 获取进程内存信息
    GetProcessMemoryInfo(ProcessInfo.hProcess, (PROCESS_MEMORY_COUNTERS*)&pmc, sizeof(pmc));

    // 获取进程CPU时间
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

    ULONGLONG totalKernelTime = kernelTimeUL.QuadPart / 10; // 转换为微秒
    ULONGLONG totalUserTime = userTimeUL.QuadPart / 10;     // 转换为微秒

    // 关闭进程句柄
    CloseHandle(ProcessInfo.hProcess);
    CloseHandle(ProcessInfo.hThread);

    string command = "copy ";
    command += argv[3];
    command += " con>nul";
    system(command.c_str());
    command = "del /f ";
    command += argv[3];
    system(command.c_str());
    command = "del /f ";
    command += argv[2];
    system(command.c_str());

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
