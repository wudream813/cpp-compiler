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

int main(int argc, char* argv[]) {
    if (argc != 4) {
        printf("用法：ConsoleInfoFileIO <command> <inputFile> <outputFile>\n");
        return -1;
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
