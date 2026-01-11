#include <windows.h>
#include <shlwapi.h>
#include <cstdio>
#include <ctime>

using namespace std;

// 递归删除目录
void removeDir(const char* path) {
    WIN32_FIND_DATAA ffd;
    char search[MAX_PATH];
    snprintf(search, MAX_PATH, "%s\\*", path);
    HANDLE hFind = FindFirstFileA(search, &ffd);
    if (hFind != INVALID_HANDLE_VALUE) {
        do {
            if (strcmp(ffd.cFileName, ".") == 0 || strcmp(ffd.cFileName, "..") == 0) continue;
            char full[MAX_PATH];
            snprintf(full, MAX_PATH, "%s\\%s", path, ffd.cFileName);
            if (ffd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
                removeDir(full);
            else
                DeleteFileA(full);
        } while (FindNextFileA(hFind, &ffd));
        FindClose(hFind);
    }
    RemoveDirectoryA(path);
}

// 使用 Windows API 拷贝文件
bool copyFileWin(const char* src, const char* dst) {
    return CopyFileA(src, dst, FALSE) != 0;
}

// 创建临时目录
bool createTempSubDir(char* tempDir, size_t size) {
    char base[MAX_PATH];
    if (!GetTempPathA(MAX_PATH, base)) return false;

    snprintf(tempDir, size, "%sdream-cpp-compiler\\tmp_%lld", base, (long long)time(NULL));

    return CreateDirectoryA(tempDir, NULL) || GetLastError() == ERROR_ALREADY_EXISTS;
}

// 自定义 PROCESS_MEMORY_COUNTERS
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

// 在临时目录运行目标 exe，同时收集 CPU/内存/运行时间信息
int runTargetExe(const char* exePath, const char* workingDir) {
    STARTUPINFOA si = { sizeof(si) };
    PROCESS_INFORMATION pi;
    memset(&pi, 0, sizeof(pi));

    LARGE_INTEGER startTime, endTime, freq;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&startTime);

    char cmdLine[MAX_PATH * 2];
    snprintf(cmdLine, sizeof(cmdLine), "\"%s\"", exePath);

    if (!CreateProcessA(NULL, cmdLine, NULL, NULL, FALSE, 0, NULL, workingDir, &si, &pi)) {
        printf("无法创建进程：%s\n", exePath);
        return -1;
    }

    // 等待进程结束
    WaitForSingleObject(pi.hProcess, INFINITE);

    // 内存信息
    PROCESS_MEMORY_COUNTERS pmc = {0};
    HMODULE hPsapi = LoadLibraryA("Psapi.dll");
    if (hPsapi) {
        typedef BOOL(WINAPI *PFN_GetProcessMemoryInfo)(HANDLE, PROCESS_MEMORY_COUNTERS*, DWORD);
        PFN_GetProcessMemoryInfo pGetProcessMemoryInfo =
            (PFN_GetProcessMemoryInfo)GetProcAddress(hPsapi, "GetProcessMemoryInfo");
        if (pGetProcessMemoryInfo) {
            pmc.cb = sizeof(pmc);
            pGetProcessMemoryInfo(pi.hProcess, &pmc, sizeof(pmc));
        }
        FreeLibrary(hPsapi);
    }

    // CPU 时间
    FILETIME creationTime, exitTime, kernelTime, userTime;
    GetProcessTimes(pi.hProcess, &creationTime, &exitTime, &kernelTime, &userTime);

    QueryPerformanceCounter(&endTime);
    LONGLONG executionTime = (endTime.QuadPart - startTime.QuadPart) * 1000000 / freq.QuadPart;

    DWORD returnValue;
    GetExitCodeProcess(pi.hProcess, &returnValue);

    ULARGE_INTEGER kTime, uTime;
    kTime.LowPart = kernelTime.dwLowDateTime; kTime.HighPart = kernelTime.dwHighDateTime;
    uTime.LowPart = userTime.dwLowDateTime; uTime.HighPart = userTime.dwHighDateTime;

    ULONGLONG totalKernelTime = kTime.QuadPart / 10;
    ULONGLONG totalUserTime = uTime.QuadPart / 10;

    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);

    printf("\n-----------------------------------------------");
    printf("\n总执行时间：%lld.%03lld ms", executionTime / 1000, executionTime % 1000);
    printf("\n内存峰值：%llu KB", pmc.PeakWorkingSetSize >> 10);
    printf("\nCPU内核时间：%.3f 秒", totalKernelTime / 1000000.0);
    printf("\nCPU用户时间：%.3f 秒", totalUserTime / 1000000.0);
    printf("\n总CPU时间：%.3f 秒", (totalKernelTime + totalUserTime) / 1000000.0);
    printf("\n程序返回值：%ld (0x%lX)", returnValue, returnValue);
    printf("\n-----------------------------------------------");

    return returnValue;
}

int main(int argc, char* argv[]) {
    if (argc != 6) {
        printf("用法：ConsoleInfoChangeFileIO.exe <command> <PrograminputFile> <ProgramoutputFile> <WillinputFile> <WilloutputFile>\n");
        return -1;
    }

    const char* commandArg = argv[1];
    const char* programInput = argv[2];
    const char* programOutput = argv[3];
    const char* willInput = argv[4];
    const char* willOutput = argv[5];

    char tempDir[MAX_PATH], tempInput[MAX_PATH], tempOutput[MAX_PATH], tempExe[MAX_PATH];

    if (!createTempSubDir(tempDir, sizeof(tempDir))) {
        printf("无法创建临时目录\n");
        return -1;
    }

    snprintf(tempInput, MAX_PATH, "%s\\%s", tempDir, willInput);
    snprintf(tempOutput, MAX_PATH, "%s\\%s", tempDir, willOutput);

    // 将 WillinputFile 复制到临时目录 programInput
    if (!copyFileWin(programInput, tempInput)) {
        printf("无法复制输入文件到临时目录\n");
        removeDir(tempDir);
        return -1;
    }

    // 执行临时 exe 并收集信息
    int ret = runTargetExe(commandArg, tempDir);

    // 将输出文件复制回 WilloutputFile
    copyFileWin(tempOutput, programOutput);

    // 删除临时目录
    removeDir(tempDir);

    return ret;
}
