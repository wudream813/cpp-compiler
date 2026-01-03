#include <iostream>
#include <fstream>
#include <cstring>
#include <unistd.h>
#include <fcntl.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <sys/time.h>  // 用于gettimeofday
#include <cstdio>
#include <cstdlib>

using namespace std;

int main(int argc, char* argv[]) {
    if (argc != 4) {
        printf("用法：ConsoleInfoFileIO <command> <inputFile> <outputFile>\n");
        return -1;
    }

    const char* command = argv[1];
    const char* inputFile = argv[2];
    const char* outputFile = argv[3];

    int inputFd = open(inputFile, O_RDONLY);
    if (inputFd == -1) {
        perror("打开输入文件失败");
        return -1;
    }

    int outputFd = open(outputFile, O_WRONLY | O_CREAT | O_TRUNC, 0666);
    if (outputFd == -1) {
        perror("打开输出文件失败");
        close(inputFd);
        return -1;
    }

    // 使用gettimeofday记录开始时间（替代chrono）
    struct timeval start, end;
    gettimeofday(&start, NULL);

    pid_t pid = fork();
    if (pid == -1) {
        perror("创建进程失败");
        close(inputFd);
        close(outputFd);
        return -1;
    }

    if (pid == 0) {
        dup2(inputFd, STDIN_FILENO);
        dup2(outputFd, STDOUT_FILENO);
        dup2(outputFd, STDERR_FILENO);
        close(inputFd);
        close(outputFd);

        // 分割命令字符串
        char* args[] = {argv[1], NULL};

        execvp(args[0], args);
        perror("execvp 失败");
        exit(127);
    }

    int status;
    waitpid(pid, &status, 0);

    // 使用gettimeofday记录结束时间并计算耗时（微秒）
    gettimeofday(&end, NULL);
    long long elapsed = (end.tv_sec - start.tv_sec) * 1000000LL +(end.tv_usec - start.tv_usec);

    // 获取资源使用信息
    struct rusage usage;
    getrusage(RUSAGE_CHILDREN, &usage);

    long memKB = usage.ru_maxrss;
    double userSec = usage.ru_utime.tv_sec + usage.ru_utime.tv_usec / 1e6;
    double sysSec = usage.ru_stime.tv_sec + usage.ru_stime.tv_usec / 1e6;

    close(inputFd);
    close(outputFd);

    printf("\n-----------------------------------------------");
    printf("\n总执行时间：%.3f ms", elapsed / 1000.0);  // 微秒转毫秒
    printf("\n内存使用：%ld KB", memKB);
    printf("\nCPU用户时间：%.3f 秒", userSec);
    printf("\nCPU系统时间：%.3f 秒", sysSec);
    printf("\n总CPU时间：%.3f 秒", userSec + sysSec);
    printf("\n程序返回值：%d (0x%X)", WEXITSTATUS(status), WEXITSTATUS(status));
    printf("\n-----------------------------------------------\n");
    return 0;
}
