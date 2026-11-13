#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <cctype>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <limits.h>
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

bool shouldExclude(const char* name, const char* exclude1, const char* exclude2, const char* exclude3, const char* exclude4) {
    if (!name) return false;
    const char* base = strrchr(name, '/');
    if (base) base++; else base = name;
    const char* b2 = strrchr(name, '\\');
    if (b2 && (!base || b2 > base)) base = b2 + 1;
    const char* exs[] = {exclude1, exclude2, exclude3, exclude4};
    for (int i=0;i<4;i++) if (exs[i] && exs[i][0]) {
        const char* eb = strrchr(exs[i], '/');
        if (eb) eb++; else eb = exs[i];
        const char* eb2 = strrchr(exs[i], '\\');
        if (eb2 && (!eb || eb2 > eb)) eb = eb2 + 1;
        if (strcmp(base, eb)==0 || strcmp(name, exs[i])==0) return true;
    }
    return false;
}

void copyFileContent(const char* src, const char* dst) {
    int in = open(src, O_RDONLY);
    if (in < 0) return;
    int out = open(dst, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (out < 0) { close(in); return; }
    char buf[8192];
    ssize_t n;
    while ((n = read(in, buf, sizeof(buf))) > 0) write(out, buf, n);
    close(in); close(out);
}

void mirrorWorkDirRecursive(const char* workDir, const char* tempDir, const char* ex1, const char* ex2, const char* ex3, const char* ex4) {
    DIR* d = opendir(workDir);
    if (!d) return;
    struct dirent* e;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        if (shouldExclude(e->d_name, ex1, ex2, ex3, ex4)) continue;
        char src[PATH_MAX], dst[PATH_MAX];
        snprintf(src, sizeof(src), "%s/%s", workDir, e->d_name);
        snprintf(dst, sizeof(dst), "%s/%s", tempDir, e->d_name);
        struct stat st;
        if (lstat(src, &st) != 0) continue;
        if (S_ISLNK(st.st_mode)) {
            char linkTarget[PATH_MAX];
            ssize_t len = readlink(src, linkTarget, sizeof(linkTarget)-1);
            if (len > 0) {
                linkTarget[len]=0;
                symlink(linkTarget, dst);
            }
            continue;
        }
        if (S_ISDIR(st.st_mode)) {
            mkdir(dst, 0755);
            mirrorWorkDirRecursive(src, dst, ex1, ex2, ex3, ex4);
        } else if (S_ISREG(st.st_mode)) {
            copyFileContent(src, dst);
        }
    }
    closedir(d);
}

void mirrorWorkDir(const char* workDir, const char* tempDir, const char* ex1, const char* ex2, const char* ex3, const char* ex4) {
    if (!workDir || !*workDir) return;
    struct stat st;
    if (stat(workDir, &st)!=0 || !S_ISDIR(st.st_mode)) return;
    char realWork[PATH_MAX], realTemp[PATH_MAX];
    if (realpath(workDir, realWork) && realpath(tempDir, realTemp)) {
        if (strncmp(realWork, realTemp, strlen(realTemp))==0 || strncmp(realTemp, realWork, strlen(realWork))==0) return;
    }
    mirrorWorkDirRecursive(workDir, tempDir, ex1, ex2, ex3, ex4);
}



void removeDir(const char* path) {
    DIR* d = opendir(path);
    if (d) {
        struct dirent* p;
        while ((p = readdir(d))) {
            if (!strcmp(p->d_name, ".") || !strcmp(p->d_name, "..")) continue;
            char buf[PATH_MAX];
            snprintf(buf, PATH_MAX, "%s/%s", path, p->d_name);
            struct stat statbuf;
            if (!lstat(buf, &statbuf)) {
                if (S_ISLNK(statbuf.st_mode)) unlink(buf);
                else if (S_ISDIR(statbuf.st_mode)) removeDir(buf);
                else unlink(buf);
            }
        }
        closedir(d);
    }
    rmdir(path);
}

bool copyFileLinux(const char* src, const char* dst) {
    int fd_in = open(src, O_RDONLY);
    if (fd_in < 0) return false;
    int fd_out = open(dst, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd_out < 0) { close(fd_in); return false; }

    char buffer[4096];
    ssize_t bytes;
    while ((bytes = read(fd_in, buffer, sizeof(buffer))) > 0) {
        write(fd_out, buffer, bytes);
    }
    close(fd_in);
    close(fd_out);
    return true;
}

bool createTempSubDir(char* tempDir, size_t size) {
    const char* base = getenv("TMPDIR");
    if (!base) base = "/tmp";
    snprintf(tempDir, size, "%s/dream-cpp-compiler/tmp_%lld_%d_%d", base, (long long)time(NULL), (int)getpid(), rand() % 10000);
    return mkdir(tempDir, 0777) == 0;
}

int runTargetExe(const char* exePath, const char* workingDir) {
    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);

    pid_t pid = fork();
    if (pid == 0) {
        if (workingDir) chdir(workingDir);
        char* args[] = { (char*)exePath, NULL };
        execvp(exePath, args);
        _exit(127);
    }

    int status;
    struct rusage usage;
    waitpid(pid, &status, 0);
    getrusage(RUSAGE_CHILDREN, &usage);
    clock_gettime(CLOCK_MONOTONIC, &end);

    long long executionTimeMs = (end.tv_sec - start.tv_sec) * 1000 + (end.tv_nsec - start.tv_nsec) / 1000000;
    double userTime = usage.ru_utime.tv_sec + usage.ru_utime.tv_usec / 1e6;
    double sysTime = usage.ru_stime.tv_sec + usage.ru_stime.tv_usec / 1e6;
    long memoryPeakKB = usage.ru_maxrss;
    int returnValue = WIFEXITED(status) ? WEXITSTATUS(status) : (128 + WTERMSIG(status));

    printf("\n-----------------------------------------------");
    printf("\n总执行时间：%lld.%03lld ms", executionTimeMs / 1000, executionTimeMs % 1000);
    printf("\n内存峰值：%ld KB", memoryPeakKB);
    printf("\nCPU内核时间：%.3f 秒", sysTime);
    printf("\nCPU用户时间：%.3f 秒", userTime);
    printf("\n总CPU时间：%.3f 秒", sysTime + userTime);
    printf("\n程序返回值：%d (0x%X)", returnValue, returnValue);
    printf("\n-----------------------------------------------");

    return returnValue;
}

int main(int argc, char* argv[]) {
    const char* workDir = "";
    if (argc == 7) workDir = argv[6];
    else if (argc != 6) {
        printf("用法：ConsoleInfoChangeFileIO <command> <PrograminputFile> <ProgramoutputFile> <WillinputFile> <WilloutputFile>\n");
        return 0;
    }
    bool progInputIsCon = isConsoleFile(argv[2]);
    bool progOutputIsCon = isConsoleFile(argv[3]);
    bool willInputIsCon = isConsoleFile(argv[4]);
    bool willOutputIsCon = isConsoleFile(argv[5]);
    if (willInputIsCon && willOutputIsCon) return runTargetExe(argv[1], nullptr);

    char tempDir[PATH_MAX], tempInput[PATH_MAX], tempOutput[PATH_MAX];
    if (!createTempSubDir(tempDir, sizeof(tempDir))) {
        printf("无法创建临时目录\n");
        return -1;
    }
    snprintf(tempInput, PATH_MAX, "%s/%s", tempDir, argv[4]);
    snprintf(tempOutput, PATH_MAX, "%s/%s", tempDir, argv[5]);
    if (workDir && *workDir) {
        mirrorWorkDir(workDir, tempDir, argv[2], argv[3], argv[4], argv[5]);
    }

    if (!copyFileLinux(argv[2], tempInput)) {
        printf("无法复制输入文件到临时目录\n");
        removeDir(tempDir);
        return -1;
    }

    int ret = runTargetExe(argv[1], tempDir);
    copyFileLinux(tempOutput, argv[3]);
    removeDir(tempDir);
    return ret;
}
