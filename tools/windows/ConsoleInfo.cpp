#include <Windows.h>
#include <stdio.h>
#include <conio.h>

// Զ PROCESS_MEMORY_COUNTERS ṹ
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

// ָ
typedef BOOL(WINAPI *PFN_GetProcessMemoryInfo)(HANDLE, PROCESS_MEMORY_COUNTERS*, DWORD);

int main(int argc, char* argv[]) {
    const char* workDir = "";
    bool workDirDirect = false;
    if (argc == 4) { workDir = argv[2]; workDirDirect = argv[3][0]=='1'; }
    else if (argc == 3) workDir = argv[2];
    else if (argc != 2) {
        printf("÷ConsoleInfo.exe <command>\n");
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
        printf("\n޷̣%s", cmdLine);
        return -1;
    }

    // ȴ̽
    WaitForSingleObject(ProcessInfo.hProcess, INFINITE);

    // ̬ GetProcessMemoryInfo
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

    // ȡCPUʱ
    FILETIME creationTime, exitTime, kernelTime, userTime;
    GetProcessTimes(ProcessInfo.hProcess, &creationTime, &exitTime, &kernelTime, &userTime);

    // ʱ
    QueryPerformanceCounter(&EndingTime);
    LONGLONG executionTime = (EndingTime.QuadPart - StartingTime.QuadPart) * 1000000 / Frequency.QuadPart;

    // ȡ˳
    DWORD returnValue;
    GetExitCodeProcess(ProcessInfo.hProcess, &returnValue);

    // FILETIMEתΪ΢
    ULARGE_INTEGER kernelTimeUL, userTimeUL;
    kernelTimeUL.LowPart = kernelTime.dwLowDateTime;
    kernelTimeUL.HighPart = kernelTime.dwHighDateTime;
    userTimeUL.LowPart = userTime.dwLowDateTime;
    userTimeUL.HighPart = userTime.dwHighDateTime;

    ULONGLONG totalKernelTime = kernelTimeUL.QuadPart / 10;
    ULONGLONG totalUserTime = userTimeUL.QuadPart / 10;

    // رվ
    CloseHandle(ProcessInfo.hProcess);
    CloseHandle(ProcessInfo.hThread);

    // 
    printf("\n-----------------------------------------------");
    printf("\nִʱ䣺%lld.%03lld ms", executionTime / 1000, executionTime % 1000);
    printf("\nڴֵ%llu KB", pmc.PeakWorkingSetSize >> 10);
    printf("\nCPUںʱ䣺%.3f ", totalKernelTime / 1000000.0);
    printf("\nCPUûʱ䣺%.3f ", totalUserTime / 1000000.0);
    printf("\nCPUʱ䣺%.3f ", (totalKernelTime + totalUserTime) / 1000000.0);
    printf("\n򷵻ֵ%ld (0x%lX)", returnValue, returnValue);
    printf("\n-----------------------------------------------");

    return 0;
}
