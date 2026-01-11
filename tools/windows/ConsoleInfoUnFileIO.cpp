#include <Windows.h>
#include <cstdio>
#include <ctime>

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

// 创建临时目录
bool createTempSubDir(char* tempDir, size_t size) {
    char base[MAX_PATH];
    if (!GetTempPathA(MAX_PATH, base)) return false;

    snprintf(tempDir, size, "%s\\dream-cpp-compiler\\tmp_%lld", base, (long long)time(NULL));

    return CreateDirectoryA(tempDir, NULL) || GetLastError() == ERROR_ALREADY_EXISTS;
}

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

// 将 stdin 写入文件
bool writeStdinToFile(const char* filePath) {
    HANDLE hFile = CreateFileA(filePath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) return false;

    char buffer[4096];
    DWORD readBytes, writtenBytes;
    HANDLE hStdIn = GetStdHandle(STD_INPUT_HANDLE);
    while (ReadFile(hStdIn, buffer, sizeof(buffer), &readBytes, NULL) && readBytes > 0) {
        WriteFile(hFile, buffer, readBytes, &writtenBytes, NULL);
    }

    CloseHandle(hFile);
    return true;
}

// 执行 exe 并收集 CPU/内存/运行时间信息
int runTargetExe(const char* exePath, const char* workingDir, const char* outputPath) {
    STARTUPINFOA si = { sizeof(si) };
    PROCESS_INFORMATION pi;
    memset(&pi, 0, sizeof(pi));

    LARGE_INTEGER startTime, endTime, freq;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&startTime);

    char cmdLine[MAX_PATH * 2];
    snprintf(cmdLine, sizeof(cmdLine), "\"%s\"", exePath);

    if (!CreateProcessA(NULL, cmdLine, NULL, NULL, TRUE, 0, NULL, workingDir, &si, &pi)) {
        return -1;
    }

    WaitForSingleObject(pi.hProcess, INFINITE);

    // 内存信息
    PROCESS_MEMORY_COUNTERS pmc = { sizeof(pmc) };
    HMODULE hPsapi = LoadLibraryA("Psapi.dll");
    if (hPsapi) {
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

    HANDLE hFile = CreateFileA(outputPath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        printf("错误：无法打开输出文件");
    } else {
        char buffer[4096];
        DWORD readBytes;
        HANDLE hConsole = GetStdHandle(STD_OUTPUT_HANDLE);
        while (ReadFile(hFile, buffer, sizeof(buffer), &readBytes, NULL) && readBytes > 0) {
            DWORD written;
            WriteConsoleA(hConsole, buffer, readBytes, &written, NULL);
        }

        CloseHandle(hFile);
    }

    // 输出性能信息
    printf("\n-----------------------------------------------");
    printf("\n总执行时间：%lld.%03lld ms", executionTime / 1000, executionTime % 1000);
    printf("\n内存使用：%lu KB", (unsigned long)(pmc.PeakWorkingSetSize >> 10));
    printf("\nCPU内核时间：%.3f 秒", totalKernelTime / 1000000.0);
    printf("\nCPU用户时间：%.3f 秒", totalUserTime / 1000000.0);
    printf("\n总CPU时间：%.3f 秒", (totalKernelTime + totalUserTime) / 1000000.0);
    printf("\n程序返回值：%ld (0x%lX)", returnValue, returnValue);
    printf("\n-----------------------------------------------");

    return returnValue;
}

int main(int argc, char* argv[]) {
    if (argc != 4) {
        printf("用法：ConsoleInfoUnFileIO.exe <command> <inputFile> <outputFile>\n");
        return -1;
    }

    const char *inputFile = argv[2];
    const char *outputFile = argv[3];

    char tempDir[MAX_PATH];
    if (!createTempSubDir(tempDir, sizeof(tempDir))) {
        printf("无法创建临时目录\n");
        return -1;
    }

    char tempInput[MAX_PATH], tempOutput[MAX_PATH];
    snprintf(tempInput, MAX_PATH, "%s\\%s", tempDir, inputFile);
    snprintf(tempOutput, MAX_PATH, "%s\\%s", tempDir, outputFile);

    if (!writeStdinToFile(tempInput)) {
        printf("无法写入临时输入文件\n");
        removeDir(tempDir);
        return -1;
    }

    // 执行命令并收集信息
    int ret = runTargetExe(argv[1], tempDir, tempOutput);

    // 删除临时目录
    removeDir(tempDir);

    return ret;
}
