#include <cctype>
#include <windows.h>
#include <shlwapi.h>
#include <cstdio>
#include <ctime>
bool isConsoleFile(const char* p) {
    if (!p || !*p) return false;
    const char* s = p;
    while (*s && (*s == ' ' || *s == '\t' || *s == '\r' || *s == '\n')) s++;
    size_t len = strlen(s);
    while (len > 0 && (s[len-1] == ' ' || s[len-1] == '\t' || s[len-1] == '\r' || s[len-1] == '\n')) len--;
    if (len == 0) return false;
    char tmp[512];
    if (len >= sizeof(tmp)) return false;
    memcpy(tmp, s, len);
    tmp[len] = 0;
    for (size_t i=0;i<len;i++) tmp[i]=tolower((unsigned char)tmp[i]);
    if (!strcmp(tmp,"con")||!strcmp(tmp,"conin$")||!strcmp(tmp,"conout$")||!strcmp(tmp,"nul")||!strcmp(tmp,"aux")||!strcmp(tmp,"prn")) return true;
    if (!strcmp(tmp,"/dev/stdin")||!strcmp(tmp,"/dev/stdout")||!strcmp(tmp,"/dev/stderr")||!strcmp(tmp,"/dev/tty")||!strcmp(tmp,"/dev/console")) return true;
    if (!strncmp(tmp,"/dev/pts/",9)) return true;
    const char* base = strrchr(tmp,'/');
    const char* b2 = strrchr(tmp,'\\');
    if (b2 && (!base || b2>base)) base=b2;
    if (base) base++; else base=tmp;
    const char* dot=strrchr(base,'.');
    size_t nlen=dot? (size_t)(dot-base): strlen(base);
    char name[64];
    if (nlen>=sizeof(name)) return false;
    memcpy(name,base,nlen); name[nlen]=0;
    const char* reserved[]={"con","conin$","conout$","nul","aux","prn","com1","com2","com3","com4","com5","com6","com7","com8","com9","lpt1","lpt2","lpt3","lpt4","lpt5","lpt6","lpt7","lpt8","lpt9"};
    for(size_t i=0;i<sizeof(reserved)/sizeof(reserved[0]);i++) if(!strcmp(name,reserved[i])) return true;
    if(!strcmp(base,"con")||!strcmp(base,"nul")||!strcmp(base,"aux")||!strcmp(base,"prn")) return true;
    return false;
}


using namespace std;

// ݹɾĿ¼
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

// ʹ Windows API ļ
bool copyFileWin(const char* src, const char* dst) {
    return CopyFileA(src, dst, FALSE) != 0;
}

// ʱĿ¼
bool createTempSubDir(char* tempDir, size_t size) {
    char base[MAX_PATH];
    if (!GetTempPathA(MAX_PATH, base)) return false;

    snprintf(tempDir, size, "%sdream-cpp-compiler\\tmp_%lld", base, (long long)time(NULL));

    return CreateDirectoryA(tempDir, NULL) || GetLastError() == ERROR_ALREADY_EXISTS;
}

// Զ PROCESS_MEMORY_COUNTERS
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

// ʱĿ¼Ŀ exeͬʱռ CPU/ڴ/ʱϢ
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
        printf("޷̣%s\n", exePath);
        return -1;
    }

    // ȴ̽
    WaitForSingleObject(pi.hProcess, INFINITE);

    // ڴϢ
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

    // CPU ʱ
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
    printf("\nִʱ䣺%lld.%03lld ms", executionTime / 1000, executionTime % 1000);
    printf("\nڴֵ%llu KB", pmc.PeakWorkingSetSize >> 10);
    printf("\nCPUںʱ䣺%.3f ", totalKernelTime / 1000000.0);
    printf("\nCPUûʱ䣺%.3f ", totalUserTime / 1000000.0);
    printf("\nCPUʱ䣺%.3f ", (totalKernelTime + totalUserTime) / 1000000.0);
    printf("\n򷵻ֵ%ld (0x%lX)", returnValue, returnValue);
    printf("\n-----------------------------------------------");

    return returnValue;
}

int main(int argc, char* argv[]) {
    if (argc != 6) {
        printf("÷ConsoleInfoChangeFileIO.exe <command> <PrograminputFile> <ProgramoutputFile> <WillinputFile> <WilloutputFile>\n");
        return -1;
    }
    bool progInputIsCon = isConsoleFile(argv[2]);
    bool progOutputIsCon = isConsoleFile(argv[3]);
    bool willInputIsCon = isConsoleFile(argv[4]);
    bool willOutputIsCon = isConsoleFile(argv[5]);
    if (willInputIsCon && willOutputIsCon) return runTargetExe(argv[1], nullptr);


    const char* commandArg = argv[1];
    const char* programInput = argv[2];
    const char* programOutput = argv[3];
    const char* willInput = argv[4];
    const char* willOutput = argv[5];

    char tempDir[MAX_PATH], tempInput[MAX_PATH], tempOutput[MAX_PATH], tempExe[MAX_PATH];

    if (!createTempSubDir(tempDir, sizeof(tempDir))) {
        printf("޷ʱĿ¼\n");
        return -1;
    }

    snprintf(tempInput, MAX_PATH, "%s\\%s", tempDir, willInput);
    snprintf(tempOutput, MAX_PATH, "%s\\%s", tempDir, willOutput);

    //  WillinputFile ƵʱĿ¼ programInput
    if (!copyFileWin(programInput, tempInput)) {
        printf("޷ļʱĿ¼\n");
        removeDir(tempDir);
        return -1;
    }

    // ִʱ exe ռϢ
    int ret = runTargetExe(commandArg, tempDir);

    // ļƻ WilloutputFile
    copyFileWin(tempOutput, programOutput);

    // ɾʱĿ¼
    removeDir(tempDir);

    return ret;
}
