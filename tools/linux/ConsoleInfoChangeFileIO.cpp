#include <iostream>
#include <cstring>
#include <cstdlib>
#include <libgen.h>
#include <sys/wait.h>
#include <string>
#include <unistd.h>
#include <sys/resource.h>
#include <sys/time.h>

using namespace std;

int main(int argc, char* argv[]) {
    if (argc != 6) {
        printf("用法：ConsoleInfoChangeFileIO <command> <PrograminputFile> <ProgramoutputFile> <WillinputFile> <WilloutputFile>\n");
        return -1;
    }

    string programIn = argv[2];
    string programOut = argv[3];
    string willIn = argv[4];
    string willOut = argv[5];

    // 若输入文件不同则复制
    if (strcmp(argv[2], argv[4]) != 0) {
        string cmd = "cp ";
        cmd += willIn + " " + programIn;
        system(cmd.c_str());
    }

    // 记录开始时间
    struct timeval start_time, end_time;
    gettimeofday(&start_time, NULL);

    // 执行命令
    pid_t pid = fork();
    if (pid == -1) {
        perror("fork failed");
        return 1;
    }

    if (pid == 0) { // 子进程执行命令
        execl("/bin/sh", "sh", "-c", argv[1], (char*)NULL);
        perror("execl failed");
        exit(EXIT_FAILURE);
    }

    // 等待进程结束
    int status;
    waitpid(pid, &status, 0);

    // 记录结束时间
    gettimeofday(&end_time, NULL);

    // 计算总执行时间(微秒)
    long long executionTime = (end_time.tv_sec - start_time.tv_sec) * 1000000LL +
                             (end_time.tv_usec - start_time.tv_usec);

    // 获取进程资源使用情况
    struct rusage usage;
    getrusage(RUSAGE_CHILDREN, &usage);

    // 计算内存使用(KB)
    long peakMemory = usage.ru_maxrss;

    // 计算CPU时间(微秒)
    long long kernelTime = usage.ru_stime.tv_sec * 1000000LL + usage.ru_stime.tv_usec;
    long long userTime = usage.ru_utime.tv_sec * 1000000LL + usage.ru_utime.tv_usec;

    // 获取退出代码
    int returnValue = WEXITSTATUS(status);

    // 输出结果
    printf("\n-----------------------------------------------");
    printf("\n总执行时间：%lld.%03lld ms", executionTime / 1000, executionTime % 1000);
    printf("\n内存使用：%ld KB", peakMemory);
    printf("\nCPU内核时间：%.3f 秒", kernelTime / 1000000.0);
    printf("\nCPU用户时间：%.3f 秒", userTime / 1000000.0);
    printf("\n总CPU时间：%.3f 秒", (kernelTime + userTime) / 1000000.0);
    printf("\n程序返回值：%d (0x%X)", returnValue, returnValue);
    printf("\n-----------------------------------------------");

    // 删除中间输入文件
    if (strcmp(argv[2], argv[4]) != 0) {
        string delCmd = "rm -f ";
        delCmd += programIn;
        system(delCmd.c_str());
    }

    // 移动输出文件
    string moveCmd = "mv ";
    moveCmd += programOut + " " + willOut;
    system(moveCmd.c_str());

    return 0;
}
