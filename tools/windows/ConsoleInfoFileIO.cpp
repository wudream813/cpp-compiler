#include <Windows.h>
#include <stdio.h>
#include <conio.h>
#include <string.h>

#include <cctype>
#include <string>
#include <algorithm>
bool isConsoleFile(const char* path) {
    if (!path || !*path) return false;
    std::string p(path);
    std::string lower = p;
    for (char &c : lower) c = std::tolower((unsigned char)c);
    if (lower == "con" || lower == "conin$" || lower == "conout$" || lower == "nul" || lower == "aux" || lower == "prn") return true;
    if (lower == "/dev/stdin" || lower == "/dev/stdout" || lower == "/dev/stderr" || lower == "/dev/tty" || lower == "/dev/console") return true;
    if (lower.rfind("/dev/pts/", 0) == 0) return true;
    size_t sep = p.find_last_of("/\\");
    std::string base = (sep == std::string::npos) ? p : p.substr(sep + 1);
    size_t dot = base.find('.');
    std::string nameNoExt = (dot == std::string::npos) ? base : base.substr(0, dot);
    std::string nameLower = nameNoExt;
    for (char &c : nameLower) c = std::tolower((unsigned char)c);
    const std::string reserved[] = {"con","conin$","conout$","nul","aux","prn","com1","com2","com3","com4","com5","com6","com7","com8","com9","lpt1","lpt2","lpt3","lpt4","lpt5","lpt6","lpt7","lpt8","lpt9"};
    for (auto &r : reserved) if (nameLower == r) return true;
    std::string baseLower = base;
    for (char &c : baseLower) c = std::tolower((unsigned char)c);
    for (auto &r : reserved) if (baseLower == r) return true;
    return false;
}


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

// þ̳
void SetHandleInheritance(HANDLE hHandle, bool inherit) {
    SetHandleInformation(hHandle, HANDLE_FLAG_INHERIT, inherit ? HANDLE_FLAG_INHERIT : 0);
}

int main(int argc, char* argv[]) {
    if (argc != 4) {
        printf("÷ConsoleInfoFileIO.exe <command> <inputFile> <outputFile>\n");
        return -1;
    }
    bool inputIsCon = isConsoleFile(argv[2]);
    bool outputIsCon = isConsoleFile(argv[3]);
    if (inputIsCon && outputIsCon) {
        STARTUPINFOA si={sizeof(si)}; PROCESS_INFORMATION pi;
        char cmdLine[MAX_PATH*2]; snprintf(cmdLine,sizeof(cmdLine),"\"%s\"",argv[1]);
        if(!CreateProcessA(NULL,cmdLine,NULL,NULL,FALSE,0,NULL,NULL,&si,&pi)) return -1;
        WaitForSingleObject(pi.hProcess,INFINITE); DWORD c=0; GetExitCodeProcess(pi.hProcess,&c); CloseHandle(pi.hProcess); CloseHandle(pi.hThread); return (int)c;
    }
    if (inputIsCon || outputIsCon) {
        char shellCmd[4096];
        if (inputIsCon && !outputIsCon) snprintf(shellCmd,sizeof(shellCmd),"\"%s\" > \"%s\"",argv[1],argv[3]);
        else if (!inputIsCon && outputIsCon) snprintf(shellCmd,sizeof(shellCmd),"\"%s\" < \"%s\"",argv[1],argv[2]);
        else snprintf(shellCmd,sizeof(shellCmd),"\"%s\"",argv[1]);
        STARTUPINFOA si={sizeof(si)}; PROCESS_INFORMATION pi;
        char cmdLine2[4096*2]; snprintf(cmdLine2,sizeof(cmdLine2),"cmd /c %s",shellCmd);
        if(!CreateProcessA(NULL,cmdLine2,NULL,NULL,FALSE,0,NULL,NULL,&si,&pi)) return -1;
        WaitForSingleObject(pi.hProcess,INFINITE); DWORD c2=0; GetExitCodeProcess(pi.hProcess,&c2); CloseHandle(pi.hProcess); CloseHandle(pi.hThread); return (int)c2;
    }


    // ļ
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
        printf("ļʧ: %s: %d\n", argv[2], GetLastError());
        return -1;
    }

    // ļ
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
        printf("ļʧ: %s: %d\n", argv[3], GetLastError());
        CloseHandle(hInput);
        return -1;
    }

    // þ̳
    SetHandleInheritance(hInput, true);
    SetHandleInheritance(hOutput, true);

    // ȷʹANSI汾Ľṹ
    STARTUPINFOA StartupInfo;  // ʹSTARTUPINFOASTARTUPINFO
    PROCESS_INFORMATION ProcessInfo;
    memset(&ProcessInfo, 0, sizeof(ProcessInfo));
    memset(&StartupInfo, 0, sizeof(StartupInfo));
    StartupInfo.cb = sizeof(STARTUPINFOA);  // ȷָANSI汾С
    StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    StartupInfo.wShowWindow = SW_HIDE;
    StartupInfo.hStdInput = hInput;
    StartupInfo.hStdOutput = hOutput;
    StartupInfo.hStdError = hOutput;

    char cmdLine[MAX_PATH * 2];
    snprintf(cmdLine, sizeof(cmdLine), "\"%s\"", argv[1]);

    // ¼ʼʱ
    LARGE_INTEGER StartingTime, EndingTime, Frequency;
    QueryPerformanceFrequency(&Frequency);
    QueryPerformanceCounter(&StartingTime);

    // ̣ʹANSI汾CreateProcessA
    if (!CreateProcessA(
        NULL,
        cmdLine,
        NULL,
        NULL,
        TRUE,
        0,
        NULL,
        NULL,
        &StartupInfo,  // ƥ
        &ProcessInfo
    )) {
        printf("ʧ: %s: %d\n", argv[1], GetLastError());
        CloseHandle(hInput);
        CloseHandle(hOutput);
        return -1;
    }

    // ȴ̽
    WaitForSingleObject(ProcessInfo.hProcess, INFINITE);

    // ȡͳϢ
    PROCESS_MEMORY_COUNTERS pmc = {};
    HMODULE hPsapi = LoadLibraryA("Psapi.dll");
    if (hPsapi) {
        typedef BOOL(WINAPI *PFN_GetProcessMemoryInfo)(HANDLE, PROCESS_MEMORY_COUNTERS*, DWORD);
        PFN_GetProcessMemoryInfo pGetProcessMemoryInfo =
            (PFN_GetProcessMemoryInfo)GetProcAddress(hPsapi, "GetProcessMemoryInfo");
        if (pGetProcessMemoryInfo) {
            pmc.cb = sizeof(pmc);
            pGetProcessMemoryInfo(ProcessInfo.hProcess, &pmc, sizeof(pmc));
        }
        FreeLibrary(hPsapi);
    }

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

    // Դ
    CloseHandle(ProcessInfo.hProcess);
    CloseHandle(ProcessInfo.hThread);
    CloseHandle(hInput);
    CloseHandle(hOutput);

    // 
    printf("\n-----------------------------------------------");
    printf("\nִʱ䣺%lld.%03lld ms", executionTime / 1000, executionTime % 1000);
    printf("\nڴʹã%lu KB", (unsigned long)(pmc.PeakWorkingSetSize >> 10));
    printf("\nCPUںʱ䣺%.3f ", totalKernelTime / 1000000.0);
    printf("\nCPUûʱ䣺%.3f ", totalUserTime / 1000000.0);
    printf("\nCPUʱ䣺%.3f ", (totalKernelTime + totalUserTime) / 1000000.0);
    printf("\n򷵻ֵ%ld (0x%lX)", returnValue, returnValue);
    printf("\n-----------------------------------------------");
    return 0;
}
