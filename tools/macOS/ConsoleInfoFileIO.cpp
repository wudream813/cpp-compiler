#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <fcntl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/time.h>
#include <sys/resource.h>
#include <time.h>

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


int main(int argc, char* argv[]) {
    const char* workDir = "";
    bool workDirDirect = false;
    if (argc == 6) { workDir = argv[4]; workDirDirect = argv[5][0]=='1'; }
    else if (argc == 5) workDir = argv[4];
    else if (argc != 4) {
        printf("用法：ConsoleInfoFileIO <command> <inputFile> <outputFile>\n");
        return -1;
    }
    bool inputIsCon = isConsoleFile(argv[2]);
    bool outputIsCon = isConsoleFile(argv[3]);
    if (inputIsCon && outputIsCon) {
        // Both CON: directly run without redirection
        pid_t pid2 = fork();
        if (pid2 == 0) {
            char* args[] = { argv[1], NULL };
            execvp(argv[1], args);
            _exit(127);
        }
        int st; struct rusage __u; waitpid(pid2, &st, 0); getrusage(RUSAGE_CHILDREN, &__u);
        return 0;
    }
    if (inputIsCon || outputIsCon) {
        // Single CON: fallback to shell redirection which handles CON as console passthrough
        // Use exe path directly with shell to allow CON passthrough
        // We construct shell command
        char shellCmd[4096];
        if (inputIsCon && !outputIsCon) snprintf(shellCmd, sizeof(shellCmd), "\"%s\" > \"%s\"", argv[1], argv[3]);
        else if (!inputIsCon && outputIsCon) snprintf(shellCmd, sizeof(shellCmd), "\"%s\" < \"%s\"", argv[1], argv[2]);
        else snprintf(shellCmd, sizeof(shellCmd), "\"%s\"", argv[1]);
        pid_t pid3 = fork();
        if (pid3 == 0) { execl("/bin/sh", "sh", "-c", shellCmd, NULL); _exit(127); }
        int st2; waitpid(pid3, &st2, 0);
        return 0;
    }


    // 打开文件
    int fdIn = open(argv[2], O_RDONLY);
    if (fdIn < 0) {
        perror("打开输入文件失败");
        return -1;
    }

    int fdOut = open(argv[3], O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fdOut < 0) {
        perror("打开输出文件失败");
        close(fdIn);
        return -1;
    }

    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);

    pid_t pid = fork();
    if (pid == 0) {
        // Child
        // 重定向 stdin/stdout/stderr
        dup2(fdIn, STDIN_FILENO);
        dup2(fdOut, STDOUT_FILENO);
        dup2(fdOut, STDERR_FILENO);

        close(fdIn);
        close(fdOut);

        execl("/bin/sh", "sh", "-c", argv[1], NULL);
        exit(127);
    }

    // Parent
    close(fdIn);
    close(fdOut);

    int status;
    struct rusage usage;
    wait4(pid, &status, 0, &usage);
    clock_gettime(CLOCK_MONOTONIC, &end);

    long long executionTime = (end.tv_sec - start.tv_sec) * 1000 + (end.tv_nsec - start.tv_nsec) / 1000000;
    int returnValue = WIFEXITED(status) ? WEXITSTATUS(status) : (128 + WTERMSIG(status));

    long memoryKB = usage.ru_maxrss / 1024;
    double userTime = usage.ru_utime.tv_sec + usage.ru_utime.tv_usec / 1000000.0;
    double sysTime = usage.ru_stime.tv_sec + usage.ru_stime.tv_usec / 1000000.0;

    printf("\n-----------------------------------------------");
    printf("\n总执行时间：%lld.%03lld ms", executionTime / 1000, executionTime % 1000);
    printf("\n内存使用：%ld KB", memoryKB);
    printf("\nCPU内核时间：%.3f 秒", sysTime);
    printf("\nCPU用户时间：%.3f 秒", userTime);
    printf("\n总CPU时间：%.3f 秒", userTime + sysTime);
    printf("\n程序返回值：%d (0x%X)", returnValue, returnValue);
    printf("\n-----------------------------------------------\n");

    return 0;
}
